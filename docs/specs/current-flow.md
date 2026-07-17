# claude-session-monitor — Luồng hoạt động hiện tại

> Nguồn: `src/hooks/runner.js` (runtime hook standalone) + `src/services/claudeSettings.js` (đăng ký hook).
> Cơ chế: account-lock cross-machine, dùng **pinned message trên Telegram** làm shared state store.
> Nguyên tắc: **FAIL-OPEN** — mọi lỗi config/network/parse → exit 0 (không bao giờ làm hỏng Claude), trừ `exit 2` cố ý khi session bị chặn.

## Các hằng số then chốt

| Hằng số | Giá trị | Ý nghĩa |
|---|---|---|
| `HEARTBEAT_SEC` | 120s | Cửa sổ gộp: refresh `exp` remote tối đa 1 lần/window, machine-wide (`.pushed`) |
| `ttl` | `= timeout` | Lấy thẳng `config.timeout` (bỏ floor). Dùng để tính `exp` và prune `ACTIVE_DIR` cục bộ |
| `NET_TIMEOUT_MS` | 6000ms | Timeout mỗi request mạng |
| `WATCHDOG_MS` | 9000ms | Cap tuyệt đối: nếu treo → exit 0 |

> `TTL_FLOOR_SEC` (600s) **không còn dùng trong logic** — thay bằng mô hình `exp` tuyệt đối (xem mục dưới). Hằng số còn giữ để tương thích.

Hook được đăng ký: **SessionStart**, **PreToolUse**, **SessionEnd** (không có `UserPromptSubmit`).

---

## Freshness theo `exp` tuyệt đối (holder tự khai hạn)

**Vấn đề cũ:** remote chỉ lưu `ts = now`, reader (máy B) so `now - ts < cfg.ttl` bằng **ttl của B**. Máy A timeout 3600, B timeout 600 → B tưởng A chết sau 10 phút → cướp lock sớm sai.

**Fix:** holder ghi **`exp = now + timeout`** (epoch **mili giây**) lên pin. Reader chỉ so **`Date.now() < cur.exp`** — hạn do HOLDER khai, không đụng config của reader.

- Entry remote tối giản: **`{machine, mid, exp}`** (account = key email).
- `active = Date.now() < cur.exp` (fallback `cur.ts` giây cho entry cũ).
- `liveConflict = active && !ours` → ⚠️ cảnh báo (read-only, không cướp).
- Holder **hết hạn** (`!active`) & khác máy → `staleHolder` → ♻️ tiếp quản.
- **Bỏ floor**: holder còn trong window luôn được bảo vệ; đổi lại holder crash phải chờ tới `exp` (last heartbeat + timeout) mới bị cướp — muốn cướp nhanh thì đặt `timeout` nhỏ.

**Refresh `exp` khi nhiều session live:** heartbeat (PreToolUse, mỗi session throttle 120s local) nhưng **push remote gộp machine-wide** qua `.pushed` — chỉ 1 session/120s ghi `editMessageText`, cả máy chung 1 `exp`. `ACTIVE_DIR` vẫn refresh per-session để đếm refcount chính xác.

---

## 1. Tổng quan kiến trúc

```mermaid
flowchart LR
    subgraph MayA["May A (Claude Code)"]
        HA[Hook wrappers .sh]
        RA[runner.js]
        MA["Marker cuc bo<br/>/tmp/claude-csm-*.marker<br/>role + ts"]
    end
    subgraph MayB["May B (Claude Code)"]
        HB[Hook wrappers .sh]
        RB[runner.js]
        MB["Marker cuc bo"]
    end
    TG["Telegram pinned message<br/>SHARED STATE<br/>{accounts: {email: {machine, ip, session, ts}}}"]

    RA <-->|read/write state| TG
    RB <-->|read/write state| TG
    RA --> MA
    RB --> MB
    RA -->|notify| TG
    RB -->|notify| TG
```

---

## 2. SessionStart — khi mở session

```mermaid
flowchart TD
    S([SessionStart]) --> LC{loadConfig OK?}
    LC -->|Loi/chua cau hinh| EX0[exit 0 - khong lam gi]
    LC -->|OK| RS[readState tu pinned msg Telegram]
    RS --> GET["account = email<br/>machine = hostname"]
    GET --> CHK{"cur ton tai<br/>&& now - cur.ts < ttl<br/>(active)?"}

    CHK -->|Khong active / trong| ACQ
    CHK -->|Active| SAME{"cur.machine<br/>== may nay?"}
    SAME -->|Cung may| ACQ
    SAME -->|Khac may| BLOCK

    subgraph BLOCK["CONFLICT - may khac dang giu"]
        B1[writeMarker = 'blocked']
        B2["notify Telegram:<br/>Session bi chan"]
        B3["stdout additionalContext<br/>bao Claude giai thich"]
        B4[["return 0<br/>(SessionStart KHONG hard-block duoc)"]]
        B1 --> B2 --> B3 --> B4
    end

    subgraph ACQ["ACQUIRE - gianh lock"]
        A1[resolveNetInfo: ip + geo]
        A2["state.accounts[account] =<br/>{machine, ip, loc, session, ts=now}"]
        A3[writeState len Telegram]
        A4[writeMarker = 'owner']
        A5["notify: mo session"]
        A6[[return 0]]
        A1 --> A2 --> A3 --> A4 --> A5 --> A6
    end
```

**Lỗ hổng (node B4):** SessionStart chỉ `return 0` (Claude Code không cho hook này hard-block).
→ Máy A vẫn gọi được model **turn đầu tiên** (và mọi turn thuần text) trước khi bị chặn ở PreToolUse → account bị dùng song song, khác IP → sai chính sách.

---

## 3. PreToolUse — chạy trước mỗi tool call

```mermaid
flowchart TD
    P([PreToolUse]) --> RM[readMarker cuc bo]
    RM --> ROLE{role?}

    ROLE -->|"blocked"| DENY["stderr: BI CHAN<br/>return 2 -> CHAN tool"]
    ROLE -->|"khong co marker"| OPEN["return 0 (fail-open)<br/>hook cai giua chung"]
    ROLE -->|"owner"| HB{"now - ts >= 120s?<br/>(HEARTBEAT_SEC)"}

    HB -->|Chua toi han| OK0[return 0 - cho phep]
    HB -->|Toi han| REFRESH

    subgraph REFRESH["Heartbeat giu lock song"]
        R1[writeMarker owner - refresh ts local]
        R2[readState tu Telegram]
        R3{"cur.session<br/>== session nay?"}
        R3 -->|Dung| R4["cur.ts = now<br/>writeState len Telegram"]
        R3 -->|"Sai (da mat lock)"| R5[["KHONG lam gi<br/>KHONG tu chan"]]
        R1 --> R2 --> R3
    end
    REFRESH --> OK1[return 0 - van cho phep]
```

**Lỗ hổng (node R5):** nếu lock bị stale và máy khác cướp lock, owner cũ đọc thấy `cur.session != session mình` nhưng **không tự hạ xuống `blocked`** → 2 máy chạy song song, không máy nào bị chặn.

**Bản chất:** heartbeat đo **hoạt động qua tool call**, không đo **việc gọi model**. Turn thuần text tốn token nhưng không tạo heartbeat.

---

## 4. SessionEnd — khi đóng session

```mermaid
flowchart TD
    E([SessionEnd]) --> EM[readMarker]
    EM --> RMV[removeMarker - xoa marker local]
    RMV --> OWN{"role == 'owner'?"}
    OWN -->|"Khong (blocked/none)"| E0["return 0<br/>(blocked khong giu lock nao)"]
    OWN -->|Owner| CHK2[readState tu Telegram]
    CHK2 --> MATCH{"cur.session<br/>== session nay?"}
    MATCH -->|Dung| REL["delete state.accounts[account]<br/>writeState<br/>notify: dong session"]
    MATCH -->|Sai| E1[return 0 - khong release nham]
    REL --> E2[return 0]
```

---

## 5. Watchdog & fail-safe (áp cho mọi event)

```mermaid
flowchart LR
    M([main]) --> WD["setTimeout 9000ms<br/>WATCHDOG_MS -> exit 0"]
    M --> TRY{Thuc thi handler}
    TRY -->|Loi bat ky| FO["code = 0<br/>FAIL-OPEN"]
    TRY -->|OK| CODE[code tu handler]
    FO --> OUT[process.exit code]
    CODE --> OUT
    WD -.->|"Neu treo > 9s"| KILL[exit 0 - khong bao gio block Claude]
```

---

## Tổng hợp các vấn đề đã biết

| # | Vấn đề | Vị trí | Hệ quả |
|---|---|---|---|
| 1 | SessionStart không hard-block được | Sơ đồ 2, B4 | Turn đầu / text thuần vẫn gọi model → dùng song song khác IP |
| 2 | Owner mất lock không tự demote | Sơ đồ 3, R5 | Lock stale bị cướp → 2 máy chạy song song |
| 3 | Heartbeat đo tool call, không đo model call | onPreToolUse | Session tốn token nhưng lock tưởng im lặng → có thể stale |
| 4 | `editMessageText` không atomic | writeState | TOCTOU race **cross-machine** vẫn còn (cần store atomic). Race **cùng máy** đã hết: refcount ở `ACTIVE_DIR`, gate noti ở `OPEN_NOTICE`, remote entry `{machine,mid,exp}` idempotent |
| 5 | ~~Reader phán stale bằng ttl của chính nó~~ | ĐÃ FIX | Chuyển sang `exp` tuyệt đối holder khai; bỏ floor; `ttl = timeout` verbatim |

## Hướng khắc phục đề xuất

- Thêm hook **`UserPromptSubmit`** (fire trước khi prompt vào model, có thể `exit 2`) → chặn **trước** mọi model call → bịt vấn đề #1 và #3.
- `onPreToolUse` / `onUserPromptSubmit` của owner: khi đọc state thấy `cur.session != sessionId` → tự chuyển marker sang `blocked` + `return 2` → bịt #2.
- Chuyển **state/lock sang store atomic** (Redis `SET NX PX`, hoặc Firestore/Supabase transaction); Telegram chỉ giữ vai trò **notify** → bịt #4.
- Thống nhất default `timeout` giữa `init.js` và `config.js` → xử lý #5.
