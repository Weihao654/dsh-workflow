# 0.2.1-rc.20261107.40 — PARTIAL / NOT DEPLOYABLE
## What changed in .40 (against .39)

.39 could not boot the daily desktop profile: the Host exports no `DSH_PROFILE_DIR`, and
`lib/index.js` threw `AUTHORITY_LOCATION_REQUIRED: a profile-owned ledger is mandatory` during
plugin load (real boot log `desktop-next-2026-11-07.0.jsonl`, stack at
`…/.dsh/profiles/desktop/node_modules/dsh-role-chain-protocol/lib/index.js:13`). Every rehearsal
launcher had set that variable explicitly, so fixtures and the P1 retry never exercised a Host
without it. The .39 trial install was rolled back to the 0.2.0-rc.1 junction and nothing else
changed.

.40 keeps the launcher variable authoritative and adds one fallback: when this package is installed
as a real copy under `<profile>/node_modules/dsh-role-chain-protocol`, the profile directory is
derived from `import.meta.url` and accepted only if `<profile>/package.json` declares
`dsh.profile.bundles`. A `link:` symlink (realpath resolves to the repository checkout), a pnpm virtual store and a bare
environment still fail closed with the same message instead of guessing a ledger location. A Windows
directory junction keeps its own path, so it derives the profile that owns the junction (empirically
verified) — the same profile that would own the ledger, never the repository. The
authority root is unchanged: `<profile>/role-chain-authority`.

No gate, budget or admission rule changed; no new tool surface. New unit tests
`test/profile-dir.mjs` (4 cases: env wins, installed copy derives the profile, non-profile module is
refused, no source fails closed). Fixtures: 116 cases / 14 files. A desktop-style boot without
`DSH_PROFILE_DIR` is the verification target of this change; it is NOT verified by the fixture
group alone.

## What changed in .39 (against .38)

.38 was exercised by a real P1 round (`R-e214c77e`): a real short job, command evidence, an
independent review and four quiescent executions all existed, but the legal closeout was refused
with `CLOSEOUT_RESERVE_PROTECTED` while the round had used only 235,937 of 800,000 tokens. The round
was left unclosed; nothing was backfilled. Replaying that frozen ledger showed the reserve
accounting, not the budget, was wrong:

- The reserve recomputed its request count as `floor(tokens / perRequest)`. A growing estimate
  therefore *shrank* the promised request count, even though a closing turn had already been admitted
  against the larger count. The "monotonic maximum" input estimate and the closing slot promise were
  conflated in one arithmetic expression.
- A review's first admission happens before any review estimate exists, so sizing the hold from
  `max(plan, review)` still under-sized that first review draw (in P1 the review estimate was 72,755
  against a plan estimate of 43,314; a review-first round with plan 8,192 held only 61,440 against a
  94,096 draw).
- A closing draw whose own input was a new maximum was judged against the pre-draw per-request size,
  so cumulative draws could exceed the hold without any single draw looking "too big".

The fix separates the two promises instead of making the arithmetic less wrong:

- `requests` is a **grant-only slot promise**: `min(closeoutRequests, floor(limits.requests / 4))`,
  never recomputed from tokens, so it cannot shrink when an estimate grows.
- `tokens` is the **token hold**: `min(slots * perRequest, tokenCap)`, non-decreasing as the estimate
  grows, still capped at half the round budget and never below one request's estimate.
- A closing draw is judged against a hold that includes **its own pending input**
  (`closeoutReserveOf(round, pendingInput)`), because the same transaction records that estimate.

The ceilings did not move: the round token/request budget, the immutable project grant and the
half-budget token cap are unchanged, no new admission path was added, and no gate was loosened.
`test/closeout-reserve.mjs` grew from 14 to 18 cases: the fixed slot promise across a monotone
estimate sweep, the real P1 closing shape (five draws with growing contexts, no mid-turn refusal),
review-first/new-maximum sizing with restart recovery, and a cap-bound hold that refuses the next
draw with the P1 message without overdrawing. Fixtures (at .39): 112 cases / 13 files
(`closeout-reserve.mjs` 18).

Verified on this candidate: the fixture suite, a same-round replay on a throwaway copy of the real
ledger (`.38` reproduces the exact refusal message; `.39` admits the interrupted close at
257,704 <= 384,255 with the round at 20/20 requests), and refrozen fingerprints.
**Not verified:** no real Host tool entry and no real model round on `.39`; the next real closure
still needs the Key-requiring Host and model requests approved separately. The `.31`/`.34` wording
that recomputed the request count from the funded tokens is superseded here; the token-side cap
statement (`max(one request, half the round budget)`) still holds.

## What changed in .38 (against .37)

Narrow delta audit of .37 returned **fail** for two overstated statements and one weak assertion; all
three are corrected here, with no runtime change:

- The tiny-budget dispatched-round assertion now checks the two `Missing …` evidence lines by text, so
  deleting either evidence check fails the case (before, the quiescence gate alone produced the
  rejection and the case stayed green).
- `.37`'s claim that the case "pins both tiny-budget shapes" was narrowed to what it actually pins.
- `README.md` count corrected 107 -> 108; `Native: 19 files` corrected to 18 node:test files + 2 scripts;
  the test header and `.34` item 4 carry the root / non-empty qualifiers.

## What changed in .37 (against .36)

Second documentation pass after delta audit #21 returned **fail** on .36 (one absolute sentence survived,
plus two code comments repeating it), and it closes two test gaps:

- **README .34 item 5** no longer says the round "cannot be closed through the tool path at all"; it
  now separates the two shapes: nothing dispatched -> `abortedEmpty` partial/blocked close is still
  available (the close tool itself is not gated by the reserve, provided the closing call happens in an
  already-admitted turn); work dispatched without command and review rows -> no legal close.
- **`lib/usage.js` refusal message and the `lib/runtime.js` cap comment** describe the same two shapes
  instead of repeating the absolute claim.
- **The README tool table** for `chain_dispatch` mentions the .34 closing exception.
- **New fixture coverage**: `test/dispatch.mjs` now asserts a non-root plan cannot use the closing
  exception (deleting `exec.isRoot === true` fails it). `test/closeout-reserve.mjs` pins the empty
  tiny-budget shape (`abortedEmpty`) and that a dispatched round is rejected — with the two specific
  `Missing command evidence.` / `Missing independent review evidence.` lines asserted by text, so
  removing either evidence check fails the case (quiescence alone no longer satisfies the assertion).
- Fixtures: 108 cases / 13 files (`closeout-reserve.mjs` 14). Native: 18 node:test files plus
  `api.mjs`/`routes.mjs` scripts (20 spawn lines).

## What changed in .36 (against .35)

Documentation truthfulness plus one narrowing of the .34 exception, after independent review #20
returned **fail** on the .35 documents (executable behaviour and freeze passed).

- **The stale leading README block was removed.** It still described the .33 rule ("plan cannot
  dispatch review", "tiny budget can only be closed empty") as the current contract.
- **The "tiny budget is unclosable" claim was corrected with a probe.** Below ~2×(plan input +
  outputCap) the reserve can exceed the budget and the plan's own requests are refused; an
  `abortedEmpty` round still closes as partial/blocked, while a round that dispatched work cannot
  close. The .34 wording ("not closable at all") was wrong for the empty shape.
- **"No partial/blocked fiction" is now scoped to non-empty rounds**, matching
  `lib/service.js` and the existing `smoke` test.
- **`lib/usage.js` comment, `DESIGN.md` dispatch chain and the `.30` README paragraph** now describe
  the .34 closing exception instead of the pre-.34 rule.
- **`closesWithReview` now also requires `exec.isRoot === true`** (it already required role plan and
  command evidence); the dispatch fixture still passes, so the exception is not widened.
- Fixtures: 107 cases / 13 files; native: 19 files. The version remains PARTIAL: no real Host tool
  entry and no real model round has been run against this version.

## What changed in .35 (against .34)

Comment-only package: the header of `test/closeout-reserve.mjs` still said a plan can never dispatch
review, which stopped being true in .34; it now describes the .34 closing exception. The .29 section
marks its "62 entries" line as the freeze of that version. No executable code changed.

## What changed in .34 (against .33)

Independent review #19 audited the `.33` docs and found three statements that promised more than the
code delivered, plus one version string that was never updated. `.34` fixes the gap at the mechanism
level as well as in the text:

- **Closing exception (code).** A root plan that already holds command evidence may now dispatch the
  independent review that finishes the round (`lib/controller.js`, `closesWithReview`). Before that
  evidence exists the old rule still applies (`plan -> work`, `work -> code/review`), so this cannot
  start a review out of nowhere. This removes the circular path "no review row -> no closing request ->
  no way to create one" *when command evidence exists*.
- **Corrected claims.** `DESIGN.md` now says `.34`; the `.30` section no longer claims the
  undispatched-review deadlock was fully removed (it is removed only for rounds that hold command
  evidence); below about `2 × (plan input estimate + outputCap)` the reserve can equal or exceed the
  whole budget and the plan's own requests are refused with `CLOSEOUT_RESERVE_PROTECTED`. What
  happens next depends on the round: if nothing was dispatched it still closes as an
  `abortedEmpty` partial/blocked round (verified by probe in .36 — the .34 wording "unclosable at
  all" was wrong for that shape); once work has been dispatched without command and review rows the
  round cannot be closed at all.
- **No fiction about non-empty rounds.** A round that dispatched work cannot be closed as partial or
  blocked: `closeRound` requires one command row and one review row for every non-empty round. Such a
  round's legal terminal state is *stopped and left open* (as `R-ade56d1b` was) — neither a pass nor a
  close. A round that never dispatched anything is different: it closes as `abortedEmpty` with
  partial/blocked, which is the honest label for "nothing happened".
- **Counts and hygiene.** Fixtures are 107 across 13 files (`closeout-reserve.mjs` 13 cases), the
  `lib/runtime.js` cap comment and the `lib/usage.js` reservation message now describe what the code
  actually does, and the historical `.29`/`.30`/`.31` sections are marked as historical where their
  defaults would otherwise read as current.


## What changed in .33 (against .32)

Delta review #18 confirmed the .32 token-cap test is mutation-sensitive and the runtime is clean, but
found that several sentences still described the pre-fix behaviour. .33 is documentation-only:

- `README.md`, the `lib/usage.js` comment and the `test/closeout-reserve.mjs` header no longer claim the
  reserve can start a review that has not been dispatched; they state that `plan -> work` only means the
  reserve covers an already-dispatched review, and that a round can still end unclosable.
- Fixture counts corrected to 104 (13 files) and `closeout-reserve.mjs` to 10 cases; version headers,
  `DESIGN.md`, `evidence-index.json` and `package.json` all say .33.
- The stale "never zero" comment in `lib/runtime.js` now says grants below four slots hold no closing
  slot (matching the bySlots rule and the docs), and the duplicated `.23` ACCEPTANCE heading is gone.
- Runtime behaviour is unchanged from .32: no code path, gate or receipt rule was modified.

## What changed in .31 (against .30)

Independent review #16 found one HIGH defect in .30: the token side of the reserve was
`requests × (max(plan input estimate, 8192) + outputCap)` with only the *requests* quarter-capped, so
a large plan turn could make the reserve hold most of the round budget. Ordinary admission then asked
for `projected + reserve.tokens <= limits.tokens`, work and code can never draw the reserve, and a
round that had already dispatched work could no longer produce command evidence — the same deadlock
.30 set out to remove.

- The token side is now capped at half the round budget (and never below one request's estimate); the
  request count is recomputed from what that envelope can pay for. This fixes the reviewer's exact
  counterexample (plan input 100000, budget 500000: reserve 204096 instead of 408192, second plan turn
  admitted) but it is **not** a guarantee that a dispatched round is closable: if the ordinary
  envelope is exhausted before command evidence exists, the reserve cannot manufacture it.
- Known and documented limits, not silently fixed:
  - dispatch topology was `plan → work`, `work → code/review`; in .31/.32/.33 a plan could not
    dispatch an un-dispatched review (`DISPATCH_DENIED`), so the reserve covered a review that had
    already been dispatched. `.34` narrows this: a plan holding command evidence may dispatch the
    missing review (historical text kept so the .31 record stays readable);
  - request-slot reservation applies only when the grant allows at least 4 requests (`bySlots = 0` for
    1–3), so those rounds have no closing request slot;
  - a very small round budget can be entirely consumed by the reserve (reserve `>= limits.tokens`):
    the plan's own requests are then refused with `CLOSEOUT_RESERVE_PROTECTED`; an undispatched round
    still closes as `abortedEmpty`, a dispatched one cannot close (corrected in .36).
- README and evidence-index are updated for .31/.32 and state that the `_reports/` and `_work/` paths
  they cite live outside the frozen candidate.
- The limitation is unchanged and still not a guarantee: reservations are byte-size estimates, the
  fixture store cannot prove real Host timing, and a review that never returns can still leave a
  round unclosed: it cannot be reported as a partial or blocked close either, because closeRound
requires both evidence layers for every non-empty round (corrected in .34).

## What changed in .30 (against .29)

The reserve only became usable once a review row already existed, so a round whose ordinary budget
ran out before the review was dispatched could never reach a legal terminal state. Version .30 made
the reserve cover the closing **sequence**, not the last call; .34 additionally lets a plan that
already holds command evidence dispatch the missing review (see the .34 section). Without command
evidence the reserve still cannot manufacture a terminal state:

- `closeoutReserveOf` defaults to six requests (the plan's closing call, the review run, the evidence
  write and slack) and still caps at a quarter of the round's request limit.
- A request that no longer fits inside the ordinary envelope may draw on the reserve only when the
  role can still complete the closing sequence — a review execution, or a plan that already holds
  command evidence. Ordinary work and code can never spend it.
- Reserve draws are counted (`round.usage.closeout`) and the ceiling is `limits.requests + reserve`;
  once the reserve requests or its token envelope are spent the loop is refused with
  `CLOSEOUT_RESERVE_PROTECTED` instead of silently draining work.
- Genuine exhaustion keeps its own codes: `TOKEN_BUDGET_REACHED`, `REQUEST_BUDGET_REACHED`,
  `PROJECT_*`; the reserve codes only describe a round that still has a closing sequence to fund.
- An authorized project cannot lower `closeoutRequests`/`closeoutTimeMs` below the defaults, and a
  durable grant written by an older version (without those keys) keeps working instead of turning
  `AUTHORIZATION_CORRUPT`.
- `test/closeout-reserve.mjs` exercises the durable-authorization path with a real `authorityRoot`:
  reserve floors, legacy grants, ordinary work vs plan/review, review admitted before its evidence
  exists, reserve exhaustion, closed window, reserve growth from the plan input estimate, and the
  grant still capping the sequence.

Still not a hard guarantee: token reservations are estimates, the fixture store cannot prove the real
Host timing, and a review that never returns can still leave the round unclosed. Such a round is left
open and stopped - never a pass, and not a partial close either.


## What changed in .29 (against .28)

- **Closeout reserve.** Admission now holds part of the round allowance for the closing
  steps. `lib/runtime.js closeoutReserveOf(round)` computes `requests`, `tokens` and
  `timeMs`; `lib/usage.js reserveRequest` refuses ordinary work that would eat them and
  admits the closing plan request (historical .29: only once a command **and** a review row were on
  the record; since .30 command evidence alone is enough). The request hold is capped at a quarter of the round allowance so a
  small grant can still run its own work, and `openRound` refuses to switch the reserve off
  (`closeoutRequests: 0`) inside an authorized project. Historical .29 defaults were 2 closing
  requests and 120 s (current defaults: six requests, 120 s); input floor 8192 tokens; `closeoutRequests`/`closeoutTimeMs` are part of the
  frozen round budget.
- **New refusal codes**: `CLOSEOUT_RESERVE_PROTECTED`, `CLOSEOUT_WINDOW_TOO_SMALL`. They
  replace `TOKEN_BUDGET_REACHED` only when the request fits without the hold; a genuinely
  exhausted envelope still reports the project/round code first.
- **Tests**: `test/budget-admission.mjs` grows from 6 to 11 cases (ordinary work cannot
  spend the reserve, the reserve grows with the largest plan input estimate, request slots
  are held, the time reserve stops new work inside the window, in-flight reservations and
  the hold are both counted). Fixture rounds pass `closeoutRequests: 0` explicitly.
- **Rehearsal artifact**: `_reports/v29-rehearsal-output.txt` — fixture-level run of
  normal closure, delivered refused for a partial review, reserve-protected closure, time
  window, and in-flight accounting.
- Still PARTIAL: no real Host tool entry and no real model round on this version; cancel,
  deadline, descendant exit and review write refusal remain code-level or fixture-level only.

# 0.2.1-rc.20261105.28 — PARTIAL / NOT DEPLOYABLE

## What changed in .28 (against .27)

由对 `.27` 的整体只读复审（VERDICT partial / EXECUTION completed）驱动的两处收紧与三处措辞更正。

- **关轮不再静默跳过无法校验的 command 行**：`.27` 的关轮重校验对缺少 `jobId` 或 `receiptDigest` 的行执行 `continue`，这类行仍能满足"至少一条 command 证据"门禁。复审探针证实 `.27` 下删掉 `payload.jobId`、删掉 `receiptDigest`、或两者都删再加一条 pass review 与 `result:"delivered"` 都能正常关轮。`.28` 把这些行计入拒绝理由（`CLOSEOUT_REJECTED`，理由含 `cannot be re-verified`），并保留"回执被改写"判定。
- **`test/evidence-native.mjs` 增加计数守卫**：该文件原先只有两个顶层 `await run(...)`，没有 `node:test` 的 `test()`，`node --test` 仅报一个文件级 pass，删掉两个用例仍然 exit 0。`.28` 增加 `test('both native receipt cases executed and passed')`，断言 `casesRun === 2`、`results.length === 2` 且全部通过（与 `.26` 对 `windows.mjs` 的 D3 修法一致）。
- **文档措辞更正**：README / ACCEPTANCE / `evidence-index.json` 不再写"每条 command 行都会被重新校验"，改为"每条 command 行必须带 `jobId` 与 `receiptDigest`，否则关轮拒绝"；`evidence-index` 中 `receiptTrust` 明确回执无签名、同用户可整体伪造；`nativeSuite` 说明其 `evidence-native 1` 现在由计数守卫支撑；旧的 `smoke 8/8` 行更新为当前实测。

保留披露（未修）：回执无签名（同用户可伪造回执与账本）；文件符号链接用例在本机 `EPERM` 不可测；`chain_compute` 的 `wait` 结果不含 `launched`；`servicesStopped` 仍是声明；guest 进程可能比被杀掉的 `wsl.exe` 活得久；commit 校验只是形状。

# 0.2.1-rc.20261105.27 — PARTIAL / NOT DEPLOYABLE

## What changed in .27 (against .26)

由复审 #12 的 7 条残余问题驱动；两项是代码收紧，其余是过时文档纠正。

- **关轮重校验回执（原 finding 3）**：`lib/service.js` 的 `closeRound` 现在对每条 command 证据重新读取并校验其原生回执，且与记录时保存的 `receiptDigest` 比对。实测：记录证据后把回执 `exitCode` 从 0 改成 3，关轮被 `CLOSEOUT_REJECTED` 拒绝（`its receipt no longer verifies` / `its receipt changed after the command evidence was recorded`）。新夹具用例覆盖该路径。
- **"已结算"与"是否真的启动"分离（原 finding 4）**：`readJobProof` 返回值新增 `launched` 布尔；command 证据 payload 记录 `launched`。supervisor-error 回执（`launched:false`、`jobEmpty:true`、exitCode 1）在账本里仍以 `state:'completed'` 表示**记录已结束**，但它的 `launched:false` 与 `outcome:'supervisor-error'` 明确表示进程从未启动；命令证据路径继续以 `requireLaunched:true` 拒绝它。
- **evidence-index 不再夹带过时结论（原 finding 1、2）**：`evidence-index.json` 的 `status` 整块按 `.27` 实测重写（旧 `.16` 的 "tests 67 / pass 67"、`realHostMount`/`planIdentity`/`realStaticRepairLoop` 的 `verified:true` 全部移除），顶层 `historical` 字段说明旧行去向；`.16` 的真实 Host/模型证据只在 `_reports/` 与 HANDOFF。
- **未修、保留披露**：回执无签名（同用户可伪造）；文件符号链接（非目录联接）在本机无法创建，未验证；guest 进程可能比被杀掉的 `wsl.exe` 活得久；非 TAB 的 C0 控制符未穷举；commit 校验只是形状（`deadbeef` 可通过），不是 commit 存在性证明。

# 0.2.1-rc.20261105.26 — PARTIAL / NOT DEPLOYABLE

## What changed in .26 (against .25)

对 `.25` 整体独立复审（verdict partial）的处置；不放松任何门禁，只收紧关轮与自述校验。

- **D1（MEDIUM，已修）关轮校验 review verdict**：`lib/service.js` 的 `closeRound` 现在在 `result:'delivered'` 时要求每条 review 证据的 `verdict === 'pass'`，否则 `CLOSEOUT_REJECTED`；`partial`/`blocked` 仍允许 fail/partial。此前只要求"存在 review 证据"，fail 也能 delivered。
- **D2（LOW，已修）关轮自述收紧**：`version.commit` 必须是 7+ 位十六进制或字面 `(no-git)`（`not-a-real-commit` 现在被拒）；`uncovered` 不允许空白项；`closeout.servicesStopped` 记录调用方声明值（仍须为 true 才能关轮），并新增 `servicesStoppedMeans` 说明它是声明而非进程证据。
- **D3（LOW，已修）最强原生测试不再空检查**：`test/windows.mjs` 统计 `casesRun` 并新增 `test('all six native containment cases executed and passed')`，断言 6 个用例全部跑过且全部通过。node:test 把该文件记为 1 个用例（此前那个 1 是文件级空 pass），因此 `test/run.mjs` 的期望数仍是 `windows.mjs: 1`；删掉任一个 `run()` 用例会让新增断言失败。
- **D5（LOW-MEDIUM，已修）不再夹带 `.16/r4` 声明**：`evidence-index.json` 版本/候选路径/generatedAt 更新为 `.26`，并新增 `historical` 字段明确 realHostMount/真实模型回合条目属 `.16`（r4w）历史证据，对 `.26` 一律 UNKNOWN。
- **D6（LOW，已修）文档更正**：README 的 G-H 换行 env 值说法改为"被拒绝"；DESIGN.md 版本行更新；`.24` 树未随包分发，故 `.25` 声称的"相对 .24 只改测试/文档"无法在本环境复核（保留该限制）。
- **未修、保留披露**：D4（opt-in `receipt-symlink.mjs` 的 EPERM skip 不进默认入口计数，已在证据表披露）、D7（超时只 kill `wsl.exe`，guest 进程可能存活；provider profile 的 `--bind` 绑定源按信任处理；TAB 以外 C0 控制符未穷举）、D8（回执无签名，同用户可伪造）。
- **证据表口径**：Native 行中 `windows.mjs` 与 `evidence-native.mjs` 都用 `h.services.sandbox = { confine: async argv => ({ argv, enforcement: 'full' }) }` 桩代替真实文件隔离（验证 containment/job 语义，不验证文件隔离）。真实 Host 与真实模型回合对 `.26` 未执行。

# 0.2.1-rc.20261105.25 — PARTIAL / NOT DEPLOYABLE

## What changed in .25 (against .24)

对 `.24` 整体独立复审（verdict partial）的处置；只改测试入口与文档，不改证据/关轮门禁逻辑。

- **符号链接回执用例改为显式 opt-in 套件**：从 `test/evidence-interface.mjs` 移到 `test/receipt-symlink.mjs`。此前该子用例在 Windows 拒绝建链时只打印一行，node:test 仍记 `pass`，文件整体被入口判为通过——即「看起来绿、实际没验」。现在单独运行时报 `skipped 1`（本机实测），默认入口不选它，ACCEPTANCE 不再声称它「报告为 skipped 而非通过」而是指明它不在默认门禁内。
- **spawn 被拒 = 证据缺失，不是产品失败**：`test/run.mjs` 在子进程无法创建时打印 `SPAWN ERROR …`，并以 **exit 2**（证据不完整）结束，与文档的 0/1/2 语义一致（此前记为 exit 1）。
- **README 更正**：「夹具组在禁止孙进程的沙箱里也能跑」不成立于默认 spawn 模式；默认入口需要子进程，`--in-process` 是不能逐文件校验计数的弱回退。
- **ACCEPTANCE 更正**：`.17` 历史段关于「无 `jobId` 可自填 command+exitCode」的表述加注——该路径自 `.18` 起由 `COMMAND_BINDING_REQUIRED` 关闭；证据等级表按 `.25` 实测重写（夹具 87 通过、opt-in 符号链接套件 skipped、原生 19 文件通过）。
- **PE 规则未移动（与复审建议不同，理由如下）**：`bridge/wsl-bwrap.mjs` 仍在「工作区外」分支按扩展名拒绝 Windows 二进制；工作区内的 PE 故意放行，供 `test/bridge-live.mjs` R-E 证明 guest 无法回连 Windows。把拒绝上移到入口会删除该证据而不增加隔离，因此只把注释改成与实际一致。
- **保留并披露（未修）**：`runBridge` 形状下 stderr 没有 runner trailer，唯一信号是 `wsl.exe` 的退出码（本机实测；生产链路由 `bridge/runner.mjs` 自己写 trailer）。因此本报告不再声称 `JOB_EXIT_UNKNOWN` 在该路径可达；仅当 hosting 方拿不到整数退出码时才触发。回执无签名、完整性依赖只读+full 的隔离声明（见 `.24`）；`readJobProof` 用 `requireLaunched:false` 是刻意的分作用域（静止证明 ≠ 执行事实）。

## What changed in .24 (against .23)

- **回执必须来自已启动的进程**（独立复审 MED）：`lib/receipt-proof.js` 现在要求 `receipt.launched === true`，否则 `JOB_PROOF_INVALID`。此前 supervisor 创建进程失败写的 `jobEmpty=true, launched=false, reason=supervisor-error, exitCode=1` 会被当成合法 command 证据，`≥1 command 证据` 门禁可被一条从未启动的命令满足。夹具新增该形状的反向用例。
- **路径归一化先于包含性判断**：`translateArg`/`translateArgv` 折叠 `.`/`..`，堵住 `<ws>\..\..\usr\bin\perl` 在 guest 解析到白名单外二进制；`test/bridge.mjs` 增加 `..` 用例。
- **测试入口诚实性**：`test/run.mjs` 的 skipped 证据现在按文档返回 2（此前先计失败退 1，exit 2 不可达）；头部「默认 in-process」更正为默认 spawn、`--in-process` 为降级。
- 仍未解决并如实列出：`wsl.exe` 自身退出码被当作子进程码（`JOB_EXIT_UNKNOWN` 可能不触发，本机无法实测）；回执无签名、完整性依赖只读+full 的隔离声明；真实 Host 模型回合与安装验收未做。
## What changed in .23 (against .22)

- 回执信任从「绝对路径 + 后缀 + 存在」收紧为集中判定（`lib/receipt-proof.js`）：本 job 可信路径、普通文件（非目录/符号链接）、`realpath` 未换位、JSON 内容与账本身份/退出码/T0 截止一致，错误分型 `JOB_PROOF_MISSING` / `JOB_PROOF_UNTRUSTED` / `JOB_PROOF_CORRUPT` / `JOB_PROOF_INVALID`。
- `readJobProof`（原生）与 `commandEvidencePayload`（证据提交）共用同一判定，证据与静止证明不再各写一套规则；证据 payload 增 `receiptDigest/receiptCheckedAt/receiptExitAt`。
- 反向用例覆盖：空引用、不存在路径、别处同名文件、目录占位、缺失、损坏 JSON、篡改 `jobEmpty`/`exitCode`/`nonce`/`roundId`/`executionId`（均拒），修复文件后恢复接受；符号链接子用例已移出本文件到独立 opt-in 套件 `test/receipt-symlink.mjs`（本机无建链权限时该套件报 `skipped`，不计入本文件的通过数）。夹具 86 例、原生 5 套件全过（原生组需本机完整访问以 spawn Windows Job 与 WSL）。
- 仍未完成：真实 Host 模型回合（T0→job→command→review→关轮）、`chain_stop`/取消/deadline/后代退出的真实入口验证、9p/硬链接入口复验、安装验收。


## What changed in .22 (against .21)

- **Receipt proof is now a file, not a string prefix** (review .21 finding B7). Command evidence
  only accepts a `windows-job-empty:<path>` reference when the path is absolute, ends with
  `<roundId>/<executionId>/receipt.json`, and the file still exists on disk; a bare prefix or an
  invented path is `JOB_PROOF_MISSING`. Fixtures now create real receipt files instead of
  fabricating refs, so the suite exercises the existence check.
- **The receipt rule is tested.** `test/evidence-interface.mjs` now proves that a bare prefix, a
  nonexistent absolute path and a real file from another round are all refused, while a real file
  under `<roundId>/<executionId>/receipt.json` is accepted; fixtures share `test/receipt-fixture.mjs`.
- **The transport guard covers the whole payload** (finding A2). `buildWslArgs()` now runs
  `assertSafeArgv()` over every element (not only the slice after the first `--`), and `--setenv`
  values get the same refusal as guest argv, so a prebuilt vector cannot smuggle a substitution
  form through an option or environment value.
- **Release notes stop asserting an unproved host behaviour** (finding A4): the `.19` sentence
  claiming `--exec` substitutes `$VAR` is corrected to UNPROVEN, matching `bridge/wsl-bwrap.mjs`.
- **Live tests that could not fail were fixed** (finding A5): R-C is renamed to what it checks
  (system directories outside the workspace), R-E fails when its `whoami.exe` precondition is
  missing instead of passing silently, and R-F asserts the absent `/mnt` explicitly rather than
  matching a string the script always prints.
- Still PARTIAL: no real Host/model round has exercised `.22`; stop/cancel/deadline/review-write
  have native-mechanism evidence only; POSIX isolation is unverified.
## What changed in .21 (against .20)

- **Skipped evidence is not a pass.** `test/run.mjs` refuses to look green when the native group is
  requested while `DSH_BRIDGE_LIVE=0` suppresses the live WSL tests (prints `# INCOMPLETE`, exit 2),
  and `--spawn` mode now parses the `skipped` count per file, prints `SKIPPED … skipped evidence is
  not a pass`, and exits 2 if anything was skipped. Exit codes: 0 pass, 1 failure, 2 incomplete.
- **Environment-value transport boundary has native evidence.** `test/guest-boundaries.mjs` G-H
  puts an option-shaped value into `--setenv` (`R5P='a --chdir /'`) and asserts the guest `pwd` is
  still `/srv`, so the value was not re-split into a bwrap flag; a value containing a newline
  arrives as one variable (`repr` = `'a\nb'`).
- **`$` substitution is declared UNKNOWN and stays refused.** Offline probes disagreed with each
  other (one `--exec printf 'A$HOME'` printed a Windows home path; a later matrix printed every
  `$`-form literally, and expansion inside `sh -c` is the guest shell's own doing). Since the host
  behaviour cannot be proven stable, `$`/backtick/CR/LF/NUL remain `BRIDGE_UNSAFE_ARGV`; the
  failure mode is over-rejection, not a claimed confinement.
- **Bind-source `$` probed, not supported.** A workspace path containing `$HOME` bound the literal
  directory (a decoy `probe3$HOME/c/Users/...` tree was not substituted); such paths are still not
  a supported configuration.
- Still PARTIAL because no real Host/model round has exercised .21, the stop/cancel/deadline and
  review-write paths have native-mechanism evidence only, and POSIX isolation is unverified.

## What changed in .20 (against .19)

- **Latent guard bypass closed.** `buildWslArgs()` now validates the distro name
  (`DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/` → `BRIDGE_BAD_DISTRO`) and re-asserts
  `assertSafeArgv()` over every element of the payload (`.22`: the earlier "guest portion only" scope was bypassable) **even when the caller
  passes a prebuilt `guestArgs`**, so `runConfined()` (exported) can no longer hand raw argv to
  wsl.exe unguarded.
- **Freeze provenance fixed.** `refreeze.mjs` writes `**/.api-test/**` and `**/.routes-test/**` into
  the manifest's `excluded` list (it already skipped them), and the stale "r4 candidate" header is
  corrected. The out-of-tree verifier now excludes the same scratch dirs, so the two tools can no
  longer disagree about what belongs to the tree.
- **F6 assertion added.** `test/smoke.mjs` now proves an empty planning round cannot claim
  `result:'delivered'` (and that `blocked` still closes as `abortedEmpty`).
- **Stale comments corrected** in `test/guest-boundaries.mjs` (G-E): after `.19` the bridge refuses
  only the forms wsl.exe still substitutes (`$VAR`, `$(...)`, backticks, CR/LF, NUL); plain
  metacharacters are literal guest argv, which G-G proves.
- Review #3 (independent, read-only, `.19` delta) returned **pass** with these non-blocking items;
  `.20` closes the code/tooling ones. The remaining accepted risk is documented in
  `_reports/R5-V19-REPORT-20261105.md` §10.2: spaces inside the pre-`--` bwrap payload (workspace
  bind source, `--setenv` values) are not refused, and the live bridge tests happen to run with a
  workspace path that contains a space, which is why they pass.

## .19 record (kept for comparison)

## What changed in .19 (against .18)

- **Transport (re-review finding, high-med).** The bridge now calls `wsl.exe --exec /usr/bin/bwrap`
  instead of the legacy `--` separator, in both spawn sites (`bridge/wsl-bwrap.mjs` `runBridge`,
  `bridge/runner.mjs` `runConfined`) through one `buildWslArgs()` builder. With `--`, wsl.exe joined
  argv and ran the joined line through the distro's default shell, so `;`, `|`, `&&`, `<`, globs and
  quotes were interpreted **before** bwrap — outside the sandbox. Probes on this host created files
  through a space-free `;` argument. With `--exec` the same argv prints literally and creates nothing
  (`test/guest-boundaries.mjs` G-G, real WSL). `$VAR`/backtick/CR/LF/NUL stay refused, but the reason is recorded as
  **UNPROVEN** since .21: a later 25-shape argv dump under `--exec` printed every form literally, so the
  earlier "substitution" observation cannot be attributed to wsl.exe. The guard over-rejects on purpose.
- **F1** (review .18, high): `test/api.mjs` and `test/routes.mjs` no longer call `process.exit()`;
  failures fold into `process.exitCode`, so an in-process `test/run.mjs` cannot report success while a
  script failed.
- **F2** wording: `argv` = requested intent, `executedArgv` = scheduled fact (tools.js, README, fixture).
- **F3** NUL refused by `assertSafeArgv`. **F5** same-round cross-session citation rule documented
  (allowed, with provenance; cross-round is `JOB_WRONG_ROUND`).
- **F6** an empty planning round can no longer claim `result:'delivered'`.
- Freeze tooling excludes the `.api-test/` and `.routes-test/` scratch directories.
- Still **PARTIAL**: no real-model round has exercised .19, and the B-segment scenarios remain
  unverified.

## .18 record (kept for comparison)

2026-11-05 (+08:00). Scope: the candidate tree `dsh-role-chain-rc-20261105-r5` only. The main checkout
`dsh-workflow`, the live desktop profile, `Program Files` and the desktop Host were not modified; no
installation, no Host restart, no running-profile edit, and **no target-model request was sent for this
revision** (the r4w closed round stays the only real-model evidence, for `.16`).

## What changed against .17 / .16

- `.16` real-round defect (found by r4w): `chain_compute` returned a host job id while the ledger is keyed
  by `J-…`, and the ledger never stored the executed argv, so `chain_record_evidence` could not bind a
  settled job. `.17` added `spec.requested`/`spec.argv` persistence, host-id resolution, `EVIDENCE_MISMATCH`
  and provenance; **and it left the unbound `command`+`exitCode` path able to satisfy the command gate**
  (self-report standing in for a receipt). `.18` closes that: an unbound command payload now fails with
  `COMMAND_BINDING_REQUIRED`, so the close gate's "≥1 command evidence" means "≥1 receipt-bound job".
- `.18` also records `argv`/`executedArgv` arrays (execution fact) next to the display string, plus
  `ownerSessionId`/`parentExecutionId`, and tolerates whitespace-only differences while rejecting any other
  tampered field.
- Bridge transport defect found while testing read boundaries: `wsl.exe -d <distro> -- <argv...>` joins and
  re-parses argv through the distro's default shell, so `$VAR`, `${}`, `$(...)` and backticks expand
  **before bwrap** (WSL login env, `/mnt` and network included). Observed on this host:
  `sh -c 'echo literal RC=$?'` → `literal RC=0`, `$0` → `/bin/bash`. The bridge now refuses such argv
  (`BRIDGE_UNSAFE_ARGV`) instead of claiming `full` confinement for it. This is a **narrowing**, not a proof
  that the remaining transport is safe: globbing/word-splitting still happen in that outer shell.

## Evidence levels (do not conflate)

| Level | What was run | Result |
|---|---|---|
| Fixture | `node test/run.mjs` (12 files + 2 scripts, spawn mode, per-file expected counts) — re-run for `.26` | pass (87 pass, 0 fail, 0 skipped, exit 0) |
| Fixture (opt-in) | `node --test test/receipt-symlink.mjs` — symlink-at-trusted-path refusal | **skipped on this host** (link creation EPERM); the refusal is therefore unexercised here |
| Native (no model) | `node test/run.mjs --native`: `windows.mjs` real Windows Job + supervisor (**fake-full `sandbox.confine` stub: containment/job semantics, not file isolation**), `evidence-native.mjs` real compute + real receipt (same stub), `git.mjs`, `bridge-live.mjs` real WSL+bwrap denial matrix, `guest-boundaries.mjs` read/hardlink boundaries — re-run for `.26` | pass on this host (19 files, exit 0) |
| Real Host tool entry | `.16` r4w round (2 real jobs, receipts, real `wait.settled`) — **not** re-run for `.18` | historical, `.16` only |
| Real model round | r4w `R-5c343e98` (24 requests, 344,984 tokens, closeout `partial`) — **not** re-run for `.18` | historical, `.16` only |

Uncovered for `.18`: a new real Host round (so `.18`'s changed admission path has never been exercised by a
model turn), `chain_stop`/cancel/deadline/descendant-exit behaviour under a real round, real Host review-write
rejection, POSIX native layers, and installation rehearsal.

## Freeze

`FILE-FINGERPRINTS.json` in the tree root is the authoritative record (per-file `sha256` and
`manifestSha256`, recomputable with `node _work/verify-manifest.mjs`); this document deliberately does not
embed its own digest. Exclusions: `FILE-FINGERPRINTS.json`, `**/debug.log`, `**/test/results/**`,
`node_modules/**`.

# 0.2.1-rc.20261102.9 — PARTIAL / NOT DEPLOYABLE

2026-11-03 (+08:00). r4 report; supersedes all inherited r3 text. Scope: the candidate tree
`dsh-role-chain-rc-20261102-r4` only. The main checkout, the live desktop profile, `Program Files` and the
desktop Host were not touched; no installation, no restart, no running-profile edit.

## Verdict

**PARTIAL — not deployable.** A genuine isolated Windows Host + official-provider chain was executed
(`plan → work → review(fail) → code(fix) → review(pass)`), and an independent non-author read-only review
returned **partial**. The controlled-execution bridge (`WSL` + `bwrap`, `.7`) now passes a live ten-case
denial matrix at the bridge layer, but it is **not yet wired into the Host's `sandbox-local` backend**, so
`chain_compute` is still **not available** inside a running Host; the r4h round was **not formally closed**
and no installation was attempted.

## Independent review (non-author, read-only)

- Reviewer did not read the author's conclusions first; it recomputed hashes and re-derived the ledger.
- Verdict: **partial**. Full table lives in the reviewer's report; the review statement itself is captured
  in `C:\Users\Weihao Chen\Desktop\DSH\_reports\INDEPENDENT-REVIEW-r4-20261103.md`.
- Its audited snapshot was the frozen **.5** tree: 48 entries, manifest
  `45ea7c3170ffc829b4b44e62c1c3c7d3f65b5b3f23ef2b0c3638b19b2bf12582`, 48/48 file hashes and manifest
  recomputation consistent.
- Its findings R-01…R-12 are dispositioned in "Review findings and disposition" below. R-01 (tree drift
  during the review) is real: this document, `FILE-FINGERPRINTS.json`, `package.json` and the new
  `bridge/` + `test/bridge.mjs` were written after the reviewed snapshot. **`lib/*` was not modified**
  (all mtimes ≤ 20:13), so the reviewed runtime behaviour is unchanged; the additive files are listed here
  and are covered by the final freeze recorded in `FILE-FINGERPRINTS.json`.

### Final freeze (post-review)

- The tree is frozen at **50 entries**; version is taken from `plugins/l2-protocol/package.json`
  (`0.2.1-rc.20261102.6`). The authoritative `manifestSha256` and per-file digests live in
  `FILE-FINGERPRINTS.json` and are self-verifying (recompute per file, then the manifest), so this document
  deliberately does not embed its own hash.
- Exclusions are `FILE-FINGERPRINTS.json`, `**/debug.log`, `**/test/results/**`, `node_modules/**`, which
  matches the declared scope in `refreeze.mjs`; the earlier `test/results/*` wording is corrected there.
- The BOM-prefixed `evidence-summary.json` is preserved unchanged as collected; a parsed copy is written to
  `evidence-summary.bomfree.json` (R-10).

## Deterministic evidence

Run in `plugins/l2-protocol` with the DSH runtime Node:

```
node --test --test-isolation=none test/{authorization,authority-guard,role-binding,request-gate,control,dispatch,usage,git,windows}.mjs
```

- r4 tree: tests **51**, pass **51**, fail **0**, exit **0** (20.7 s), including four native Windows
  Job/supervisor scenarios; chained `test/routes.mjs` **58/58**, `test/api.mjs` **38/38**, exit 0.
- What it establishes: exact live Agent identity plus genuine retained ctx and formal
  `sessionProjections.stateOf` agreement (creation headers never grant a role); standard unprivileged even
  with a historical plan header; missing/conflicting/forged mount, projection or Agent fail closed;
  root/child boundaries; human `/chain-authorize` bootstrap with an immutable cumulative grant keeping its
  original deadline across rounds and cold reconstruction; N+1 never reaching downstream; failed attempts
  consuming their slot; idempotent receipts; cross-OS-process exclusivity of the last slot; durable-marker
  denial of cold-deleted state; persistence failure never admitting; disjoint
  uncached-input/cache-read/cache-write/output counting with reasoning inside output; reservation before
  provider I/O; unattributable/over-running streams revoking work; compute refusing to start without full
  read-only confinement; canonical-project fencing with `.dsh`/`.git`/authority protected; code-only source
  writes and review read-only.
- **Boundary (reviewer R-09)**: the r4h install copy carried an older `test/usage.mjs` (175 vs 189 lines),
  so the "52 passes" figure cannot be bound to that runtime copy; the 51/51 above is bound to the r4 tree.
- B1 bridge translation tests: `test/bridge.mjs` **5/5 pass, exit 0** (see "B1 preparation").

## Real isolated Host evidence

### r4v — mount / activation / plan identity (zero model requests)
Layout `..\..\r4v-20261103T1556\{home,work,logs,edge}`, profile `home\profiles\r4test` from the shipped
`web` template plus local copies of both candidate packages, `DSH_HOME`/`DSH_PROFILE_DIR` inside that tree.
Host `--profile r4test --no-open --port 18796`; `/role-chain/api/table` returned 200 with
`enabled:true`; `--dump-config` contained `preset-plan/work/code/review`; selecting `plan` in the GUI gave a
real session whose projection read `agentPreset=plan`, `cwd` inside the test workspace, tokens 0.

### r4h — real chain on the real provider
Env `..\..\r4h-20261103T1933`, profile `r4test`, workspace `work`, port 18793; route
`deepseek-official/deepseek-flash`; the API key existed only as a launch environment variable (never read,
never written to disk by the agent).

- Authorization: genuine human `/chain-authorize` in the live plan session `session-ee68f688`; id
  `r4h-accept-1`, round `R-b8d77e30`, budget `{tokens:1,200,000, requests:35, fixes:2, reruns:2,
  restarts:0, wallMinutes:45, outputCap:4096, testFailures:3}`, deadline `12:50:18.466Z`.
- Executions: plan `E-c035b90d` → work `E-20f3a2f7` (froze `T0-fdc4d1f7`, `no-git`) → review#1
  `E-895f89ec` (**fail**, ruling on the original 952 B / `7ae9076d…` version: `return a + b` with no
  finite/overflow check) → code `E-8c02e0f4` (12:07:22.438Z, after review#1 at 12:07:09.709Z) → review#2
  `E-304ad8a2` (**pass**, fresh session `62b194af`, line-by-line on the fixed file).
- Artifact: `work/src/sum.mjs`, 1329 B, sha256
  `32A11DC583FACC4CA21D44D53F6B3D494A54ACCE89330B9E5040ABD9339515EE`; the reviewer verified the content
  review#2 read (after stripping line numbers) is byte-identical to this file, so the pass is bound to that
  hash. `work/src/sum.mjs` on disk and `logs/evidence/sum.mjs.final` match.
- Ledger: **35/35 requests settled, 546,083 tokens** (plan 24,699 / work 436,951 / review 30,383 /
  code 54,050); no pending/failed/retry rows; reserved total 2,299,098; cacheRead 507,136; last activity
  12:07:51.957Z inside the deadline. `state-final.json` and the authority `state.json` are byte-identical.
- Role identity: five sessions with preset plan/work/review/code/review, provider `deepseek-official`,
  model `deepseek-flash`; review#2 is a different session from review#1 (fresh strategy). **Known nuance**:
  the plan session's creation header was `standard` and the role came from the mounted plan
  (`ledger openedBy.agentPreset=plan`); this is the documented legitimate case, not a forgery.
- **unknown**: `effort=low` is self-reported in `evidence-summary.json` only; no ledger/transcript field
  records effort.

### Round closure — not achieved
`control.state=completed` is the runtime execution aggregate; `closeout:null`, `closedAt:null`,
`gates:[]`, the round is still `phase: implementation` with `resumeBlocked: false`, and there is no
`chain_close_round`/`chain_gate`/`chain_stop` call in any r4e–r4h transcript.
The final plan turn was refused at admission with the exact text
`The cumulative project attempt limit is exhausted.` (`lib/authorization.js:26`), after the work actions had
completed, so the plan produced no closing summary. Continuation is blocked by code fact: `projectUsage`
sums across rounds, changing a budget on the same id → `AUTHORIZATION_IMMUTABLE` (`:42-45`), a different id
on the same path → the same immutable error, and rounds without authorization →
`AUTHORIZATION_MIGRATION_REQUIRED` (`:47`). Only the request allowance is exhausted; tokens/time have
headroom, but the project cannot be extended. **No terminal state was invented and no lock was cleared.**

## Coverage of earlier evidence (what it proves / does not)

| Item | Live evidence | Coverage |
|---|---|---|
| standard rejection | r4e session `a04a243e` (root, standard): `chain-authorize` → `ROLE_DENIED: A genuine human command targeting the live root plan is required.`; prompt → `A trusted preauthorized round binding is required before protected model I/O.` | Proves a *standard root session* cannot authorize or run protected I/O. **Not** a blanket "standard always denied": in the same env, another session (`db454d88`) became plan and authorized successfully. Real gate = mounted plan + `isRoot` + genuine human command. |
| review write restriction | No live write attempt in r4h | Only deterministic (`test/authority-guard.mjs:15-19`) + code (`lib/controller.js:554`). Needs live取证. |
| stop / cancellation | No live `chain_stop` in r4e–r4h | Only deterministic (`test/control.mjs:52-80`). Needs live取证. |
| authorization command | r4e/r4f/r4g/r4h each carry `command/run`→`command/done` records | Confirmed live. |
| "tool refusal = filesystem isolation" | r4f/r4g compute refusals | **False inference**: role/tool denials are pre-IO policy (`controller.js:538` only recognises write/edit), not OS ACL/container enforcement; they do not cover rename/link/subprocesses/plugin-internal fs. The compute refusals prove the full backend is absent. |

## Isolation status (`chain_compute`)

- Live refusals (r4f/r4g): `The sandbox did not supply full file-effect enforcement. Partial Windows ACL
  confinement is refused; nothing is launched.`
- Root cause: `dsh-sandbox-local/README.md:71` win32 chain = ACL runner only; `:53,81,131` it reports
  `partial`; `dsh-sandbox-windows-acl/README.md:12,125` reads/network/process visibility unrestricted.
- Candidate gate intact: `lib/controller.js:444` work/code only, `:465-473` requires `full`;
  `lib/managed-jobs.js:61-62` refuses non-full isolation. **Gate was never relaxed.**

## B1 preparation (unverified isolation)

- `bridge/wsl-bwrap.mjs`: translation layer for Windows Host + custom `sandbox-local.runnerCommand` +
  WSL/bwrap (path mapping, workspace at `/work`, `/mnt/c` hidden by tmpfs, executable allowlist that
  rejects `cmd.exe`/`powershell.exe`, `--unshare-all`, `--die-with-parent`, structured exit trailer).
- `test/bridge.mjs`: **5/5 pass** — translation logic only.
- Plan and R1–R10 matrix: `C:\Users\Weihao Chen\Desktop\DSH\_reports\B1-WSL-BWRAP-PLAN-20261103.md`.
  Notable escape vector **R5**: WSL interop runs Windows binaries on the Windows side via binfmt, outside
  the bwrap namespace; the current design hides `/mnt/c` and binfmt and must prove the vector is refused.
- No WSL distro was started, `bwrap` was not installed, and `full` remains an operator assertion.

## Review findings and disposition (R-01…R-12)

| id | level | finding | disposition |
|---|---|---|---|
| R-01 | blocker | tree drifted .5→.6 during review; manifest/doc/package inconsistent | Accepted. This document + `evidence-index.json` + unified version + final freeze; `lib/*` unchanged since .5 (mtimes ≤20:13); drift list is explicit above. |
| R-02 | major | top of ACCEPTANCE contradicted the r4h section | Fixed by this rewrite. |
| R-03 | major | `evidence-index.json` stale (no r4h/bridge, wrong flags) | Rewritten. |
| R-04 | major | embedded manifest hash `72d94b…` not reproducible | Removed from this document; manifest is authoritative in `FILE-FINGERPRINTS.json`. |
| R-05 | major | round not formally closed | Documented as **not achieved**; no fabricated closeout. Live closeout取证 requires new budget. |
| R-06 | major | no live review-write / stop / fs-isolation evidence | Documented truthfully in the coverage table; requires new live evidence. |
| R-07 | major | full isolation not established | Documented; B1 is the recommended route, unproven. |
| R-08 | minor | version strings inconsistent (.2/.4/.5) | Unified to `0.2.1-rc.20261102.6` in this tree. |
| R-09 | minor | 51 vs 52 test counts; r4h copy has older usage test | Counts distinguished; the 52 figure is not bound to r4h. |
| R-10 | minor | `evidence-summary.json` has a UTF-8 BOM | Original preserved; BOM-stripped copy `logs/evidence/evidence-summary.bomfree.json` added for tooling. |
| R-11 | info | r4f ledger `authorization.id` mislabelled `r4e-accept-1` | Historical record; not rewritten; noted here. |
| R-12 | info | `bridge/` not in `package.json` `files` | Fixed (`files` now lists `bridge`). |

## Controlled-execution bridge (B1, `.7`) — bridge layer proven, Host wiring pending

The Windows built-in ACL backend still reports `partial` and the plugin's `COMPUTE_ISOLATION_UNAVAILABLE`
gate still refuses it; that gate was **not** relaxed. Instead a `runnerCommand` bridge was implemented in
`bridge/wsl-bwrap.mjs` (library) and `bridge/runner.mjs` (CLI for `sandbox-local.runnerCommand`):

- the whole Linux root is `--ro-bind / /`; the workspace is re-bound at `/srv` (read-only or read-write);
- `/mnt` is replaced by an empty tmpfs, so no Windows drive is reachable;
- `/run` is replaced by an empty tmpfs, which removes the AF_UNIX socket the WSL interop helper needs;
- `/tmp`, `/root` are tmpfs, `/proc` and `/dev` are fresh, `--unshare-all` + `--die-with-parent`;
- Windows arguments inside the workspace map to `/srv/...`; Windows paths outside it are refused;
- Windows PE/script names are refused as executables; the trailer reports the real child status.

Live denial matrix — `node --test test/bridge-live.mjs`, **10/10 pass, exit 0, 5.2 s**, run on the local
`Ubuntu` distro (bwrap 0.11.1):

| Case | Result |
| --- | --- |
| R-A workspace-write: only the workspace is writable | pass |
| R-B read-only: workspace readable, writes refused | pass |
| R-C `/etc` and system writes refused | pass |
| R-D symlink in a writable temp dir cannot escape for writes | pass |
| R-E Windows PE copied into the workspace cannot re-enter Windows | pass (`UtilConnectUnix` failure, no Windows identity) |
| R-F `/mnt` unreachable, no other drives | pass |
| R-G network namespace exposes only `lo` | pass |
| R-H child exit status propagated exactly (`7`) | pass |
| R-I timeout kills the run, non-zero outcome | pass |
| R-J Windows paths outside the workspace refused before spawn | pass |

Deterministic layer: `node --test --test-isolation=none test/{authorization,authority-guard,role-binding,request-gate,control,dispatch,usage,git,windows,bridge}.mjs` → **58/58 pass**; `test/routes.mjs` 58/58;
`test/api.mjs` 38/38.

**Not yet proven:** the Host actually receives `enforcement: 'full'` from this bridge and runs
`chain_compute` end-to-end (no Host boot with `runnerCommand` yet); `wsl.exe` exit semantics inside a
Windows Job; `node`/build toolchains inside the distro (the distro has no `node`); hard links across the 9p
workspace mount; a real test/build run with exit evidence.



## Budget

- r4h: 35/35 requests, 546,083 tokens (≤1,200,000), inside wall clock.
- Cross-environment checker: exit 2, `remainingRequests 0`, `remainingTokens 653,917`,
  `BUDGET_CHECK=BLOCKED reason=new-round-requests-exhausted`.
- Historical overrun: **65 of 60 requests**, `excessRequests 5`, status **recorded-not-waived**, never reset
  or deducted by cache, and not ratified by this report.
- Fees: **unknown** (no provider billing statement); the ¥15/¥20 figures are manual stop targets, not caps.

## Known defects / unknown

- BOM in the original evidence summary (copy added); r4f id typo; r4 file exclusions are root-relative
  (`test/results/*`) while the prose said `**` — code and prose now aligned.
- `effort=low` unverifiable from the ledger.
- Preferred bridge (`wsl-bwrap`) closes the interop escape at the bridge layer (R-E), but the same
  guarantee **inside a Windows Job / Host** is unproven.
- `wsl.exe` child/exit semantics inside a Windows Job unproven; `bwrap` present in `Ubuntu` (0.11.1) but
  `node`/build toolchains are not installed there (install would need approval); hard links across the 9p
  workspace mount unproven.
- Live `chain_stop`, live review-write refusal, formal closeout: not covered.
- Fees and provider-internal retries: unknown.

## What remains before full acceptance

1. Freeze a single snapshot and review **that** snapshot (no writes during review).
2. Live取证: review write refusal, `chain_stop`, formal `chain_close_round`/`chain_gate` in a fresh project.
3. ~~Wire `bridge/runner.mjs` into `sandbox-local.runnerCommand`~~ **done for the upstream path (`.8`, see
   "Host-level sandbox wiring" below)**; still open: one real `chain_compute` test/build with exit evidence
   (needs a target-model turn and a distro toolchain decision).
4. Live取证 for round closure: `chain_close_round`/`chain_gate` in a fresh project, review-write refusal,
   `chain_stop` under a real chain.
5. Regression + second independent review of the *frozen* `.8` tree + install/use/rollback package.
6. Separate explicit deployment approval; installation itself is out of scope here.

**This document is not an acceptance pass and not an installation authorization.**

## Host-level sandbox wiring (`.8`, r4i, 2026-11-03 22:01–22:19 +08:00)

`.7` proved the bridge in isolation; `.8` wires it into a real isolated Host and proves the Host routes
confinement through it. Environment: `C:\Users\Weihao Chen\Desktop\DSH\r4i-20261103T2155`, profile
`r4test`, port 18792, Ubuntu 26.04.1 + bubblewrap 0.11.1. **0 target-model requests.**

- Wiring: `runnerCommand` set in the profile patch layer (`home\profiles\r4test\cordis.patch.yml`), not a
  CLI flag (the launcher rejected `--patch` in profile mode). A probe plugin
  (`node_modules\dsh-compute-probe`) resolves the live `sandbox` service at apply time and calls
  `sandbox.confine(argv, {mode, workspaceRoot, sessionId})`.
- Every confined argv began with the bridge runner
  (`node.exe …\bridge\runner.mjs --distro Ubuntu --workspace <T>\work …`) and reported
  `enforcement: "full"`. Per the provider README that field is an **operator assertion**; the behavioural
  matrix below is the real evidence.
- Host-path matrix (13 records, `r4i\logs\evidence\host-path-denial-matrix.jsonl`): read-only run OK
  (`RO_OK`, uid 1000); `/etc` write refused (`Read-only file system`) in both modes; workspace write succeeds
  inside the workspace; symlink to `/etc/passwd` refused; Windows PE refused pre-spawn
  (`BRIDGE_WINDOWS_BINARY`, exit 126); exit code 7 propagated; 1500 ms timeout kills the run with no
  `sleep 8`/bwrap descendants left; env contains only `PATH/HOME/TMPDIR/LANG/PWD`; `/proc/net/dev` shows
  only `lo`.
- stderr hygiene: WSL's UTF-16 localhost-proxy notice is now stripped (`stripWslNoise`, including
  NUL-separated mis-decoding); matrix `NOISY=0`, bridge unit tests 7/7.
- Not proven here: `chain_compute` itself (needs a live model turn), the `subprocess`/Windows Job layer on
  this path, `AbortSignal` cancellation semantics through the provider, hard-link aliasing on 9p, and
  Windows interop surfaces beyond `/mnt`+`/run` hiding. The Host also performs its own provider catalog
  `GET /models` at boot using the copied account credential — real network contact, no inference, disclosed.
- Frozen evidence: `r4i\logs\evidence\{host-path-denial-matrix.jsonl,host-wiring-meta.json,boot.cmd,profile-patch.yml,role-chain-table.json}`;
  narrative: `C:\Users\Weihao Chen\Desktop\DSH\_reports\HOST-PATH-EVIDENCE-20261103.md`.


## Guest-runner executable fix (`.9`, 2026-11-04)

The r4j real chain (`R-31348312`, 11 target requests, 85,802 tokens) drove `plan -> work -> chain_compute`
through the real tool entry. All three `chain_compute` jobs (`J-797e60cb`, `J-6a45ccf3`, `J-ceda62ec`) were
recorded `outcome:"not-started"` with `subprocess-local: command "sh" was not found on PATH`.

Root cause: `lib/controller.js` called `subprocess.resolveExecutable(argv[0])` on the Windows host before
`sandbox.confine()`, so a guest-only command such as `sh` was rejected even though the configured
`runnerCommand` bridge executes commands inside WSL.

Fix: exported `hasGuestRunner(sandbox)` (`configuredRunnerFailureSignatures` or `runnerCommand`); when a
guest runner is configured, `argv[0]` is passed through unresolved and `isolation.source` records
`configured-guest-runner`. Fallback: if resolution still throws and a `confine()` probe reports
`enforcement === 'full'`, the command is treated as guest-resolved; the default partial rung still rethrows.

Verification: deterministic suite `63/63` pass (new `test/compute-guest.mjs` 4 cases), `test/routes.mjs`
`58/58`, `test/api.mjs` `38/38`. The patched `lib/controller.js` and `package.json` were synced into the
r4i profile copy (`CTRL_MATCH=True`) for a live re-run.

Not yet proven: the live positive `chain_compute` path (needs a new keyed Host and the remaining 9 approved
target requests), timeout/cancel through a real guest process, and the closure/stop/review-write live cases.
`chain_status` returned `value is not lossless JSON` once during r4j; the model continued, cause unknown.
## r4k attempt and lifecycle fixes (`.10`, 2026-11-04)

Environment `C:\Users\Weihao Chen\Desktop\DSH\r4k-20261104T0915` (profile `r4test`, port 18790, route `deepseek-official/deepseek-flash`, low). A genuine `/chain-authorize` created round `R-39130f1e` with `{requests:8, tokens:300000, wallMinutes:20, outputCap:4096}`.

Result: **no `chain_compute` execution**. Seven of eight requests were spent on plan turns; the plan workflow deadlocked on round bookkeeping before any work dispatch:

- `chain_open_round` → `Error: Close the existing round; do not reset its deadline or usage.` (the authorize bootstrap already opened the round);
- `chain_close_round` → `Cannot close: No original T0. / Failure limits exceeded without a force decision... / Missing command evidence. / Missing independent review evidence.` — a planning-only round can never satisfy those conditions.

Two product defects were found and fixed (ordinary source/test fixes, verified deterministically):

1. **Guest command resolution** — `compute()` resolved `argv[0]` on the Windows host, so guest commands failed with `subprocess-local: command "sh" was not found on PATH` before `sandbox.confine` (observed live in r4j: three jobs `not-started`). `hasGuestRunner()` now skips host resolution when a guest runner is configured, with a full-enforcement `sandbox.confine` probe as a fallback; `isolation.source` records `configured-guest-runner`. Tests: `test/compute-guest.mjs` (4 cases).
2. **Bootstrap-round deadlock** — a round opened by `/chain-authorize` could be neither closed (needs T0/command/review evidence) nor replaced (open refuses while a round exists). `closeRound` now closes such a round as `abortedEmpty` (no other execution, no baseline, no evidence) and records the fact in the closeout and summary; a round that dispatched a child still requires T0 and layered evidence. Tests: `test/smoke.mjs` (2 new cases).

Deterministic state for `.10`: main suite **67/67 pass** (includes 6 bridge, 4 compute-guest, 2 lifecycle cases), `test/routes.mjs` 58/58, `test/api.mjs` 38/38.

Evidence for the r4k attempt: `C:\Users\Weihao Chen\Desktop\DSH\r4k-20261104T0915\logs\evidence\state-r4k.json`, `host-r4k.out`, `host-r4k.err`.

Still not proven: a real `chain_compute` run through the tool entry (the guest-runner fix has only unit coverage), live `chain_close_round` / `chain_gate` / `chain_stop`, a live review write refusal, and the break-glass boundary of the isolation. Verdict remains **PARTIAL / NOT DEPLOYABLE**; installation still needs separate confirmation.
## r4l attempt and windows-supervisor MAX_PATH fix (.11)

Real isolated run in `C:\Users\Weihao Chen\Desktop\DSH\r4l-20261104T1155` (port 18789, profile `r4test`, guest runner wired to `bridge/runner.mjs --distro Ubuntu`), round `R-f5db0336`, budget `{tokens:300000, requests:10, wallMinutes:30, outputCap:4096}`.

- Genuine path exercised: plan `E-0d63eb25` dispatched work `E-46175331` (T0 `T0-748fc7ff`, `commit:null`), work called `chain_compute` and the plugin created a real job execution `J-373624c3` whose `spec.json` contains the guest runner argv (`node.exe … bridge/runner.mjs --distro Ubuntu --workspace …r4l…\work --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- sh -c "echo COMPUTE_OK; exit 7"`) and `isolation:{mode:'read-only', enforcement:'full', source:'configured-guest-runner'}`.
- The job failed before writing a receipt: `hostExit {exitCode:1}`, `proofError:'Supervisor exit is not a native Job-empty receipt.'`, empty `stdout.txt`/`stderr.txt`, job left `state:'running'`.
- Root cause: `lib/windows-supervisor.ps1` wrote its JSON via `path + "." + Guid.NewGuid().ToString("N") + ".tmp"`. Under the long isolated profile path the temporary name exceeded the Windows 260-character MAX_PATH for Windows PowerShell 5.1/.NET Framework, so `prepared.json`/`ready.json`/`receipt.json` writes threw `DirectoryNotFoundException` after the child had already run.
- Fix (`.11`): temp suffix shortened to 8 hex characters, preserving atomic write semantics. Deterministic suite re-run after the change: **67/67 pass**, `test/routes.mjs` 58/58, `test/api.mjs` 38/38.
- Layer-level verification against the real spec produced by the plugin (same job directory, same argv): supervisor exit 0, `receipt.json` with `jobEmpty:true, launched:true, reason:"natural-completion", exitCode:7`, `stdout.txt = COMPUTE_OK`, `stderr.txt = BRIDGE_EXIT child=7 signal=0`.
- What this proves: the plugin's real tool entry reached the job layer with the guest runner and full read-only configuration, and the supervisor/bridge/bwrap path returns real stdout, stderr and exit code while writing a Job-empty receipt.
- What it does not prove: the plugin's own end-to-end return path (`readJobProof` → compute result → tool output to the model) was not re-executed after the fix; that requires one more authorized run. The work turn that would have reported the compute result was refused because the round's 10-request budget was already exhausted.
- Budget of this batch: 10/10 target requests settled (`Q-feeeb5`, `Q-09fca1`, `Q-be53d3`, `Q-cd74ef`, `Q-a6d8be` plan; `Q-cf08c2`, `Q-181ebe`, `Q-d4f2e8`, `Q-f83ef0`, `Q-a8528b` work); no further requests issued.

Verdict remains **PARTIAL / NOT DEPLOYABLE**.
## r4m real end-to-end chain_compute (.12)

Isolated run in `C:\Users\Weihao Chen\Desktop\DSH\r4m-20261104T1225` (port 18788, profile `r4test`, guest runner on `.11`), round `R-7439cf0e`, budget `{tokens:300000, requests:12, wallMinutes:30, outputCap:4096}`, provider `deepseek-official/deepseek-flash`, effort low.

Full path exercised with real Host + real provider:

1. plan session `session-360160f9-…` (mounted `plan`) executed `/chain-authorize` (Host command, no model request), creating the round.
2. plan `E-536f5ff5` dispatched work `E-17691b39` (child `dabc5513-…`, policy `persistent`); work froze `T0-908c4ff4` (`mode:'no-git'`, `commit:null`, `frozenAt 05:58:26.757Z`).
3. work called the real `chain_compute` tool; the plugin created job `J-b55a6dd0` with `spec.json` argv `node.exe … bridge/runner.mjs --distro Ubuntu --workspace …r4m…\work --ro-bind / / … -- sh -c "echo COMPUTE_OK; exit 7"` and `isolation:{mode:'read-only', enforcement:'full', source:'configured-guest-runner'}`.
4. supervisor + bridge + bwrap + `sh` ran: `receipt.json` = `jobEmpty:true, launched:true, reason:"natural-completion", exitCode:7`; `stdout.txt = "COMPUTE_OK"`; `stderr.txt = "BRIDGE_EXIT child=7 signal=0 at=…"`.
5. `readJobProof` accepted the receipt: the job execution is recorded `state:'completed'`, `jobsQuiescent:true`, `exitCode:7`, `evidenceRefs:["windows-job-empty:…receipt.json"]`; work's agent execution then completed (`agentExitAt 05:58:38.462Z`) after the compute result returned.

What this proves: permission/admission → Host → job → supervisor → bridge/bwrap → stdout/stderr/exit code → native Job-empty receipt → plugin proof parsing → tool result → work execution all happened for case (a), with the `.11` MAX_PATH fix in the loaded copy.

Still not proven: cases (b) workspace write refusal and (c) `/etc` denial were not reached — the round's 12 requests were exhausted (plan 4, work 8) before work could continue; no `chain_record_evidence`, `chain_close_round`, `chain_gate`, `chain_stop`, review write refusal, or `/root` re-check happened. The model-visible text of the compute result was not recoverable from the session transcript (zstd frame decode returned empty), so that sub-claim is indirect (plugin state + tool pipeline), not a quoted transcript.

Also fixed in `.12`: `chain_status({detail:'full'})` failed with `tool "chain_status" returned invalid output: value is not lossless JSON`, blocking plan's first call. New `lib/lossless.js` sanitizes the board (Date→ISO, NaN/Infinity→null, BigInt→string, functions/undefined dropped, cycles→null) and `tools.js` returns `lossless(board)`; new assertion in `test/smoke.mjs`. Deterministic: **68/68**, routes 58/58, api 38/38.

Evidence: `C:\Users\Weihao Chen\Desktop\DSH\r4m-20261104T1225\logs\evidence\` (`state-r4m.json`, `job-J-b55a6dd0-{spec,receipt,stdout,stderr,ready,prepared}`, `profile-patch.yml`, `cmd-authorize.txt`, `prompt-plan5.txt`).

Verdict remains **PARTIAL / NOT DEPLOYABLE**.
## `.14` - job-bound command evidence (r4s A-segment)

A-segment (`R-c678e974`, env `C:\Users\Weihao Chen\Desktop\DSH\r4s-20261104T2000`) ran one real dispatch turn and consumed its full 16-request budget. It produced `T0-a516fddd`, four real `chain_compute` jobs (`J-39b0b274` exit 0, `J-f45e4521` exit 7, `J-c982309c` exit 1, `J-99b4a959` exit 1) all `natural-completion` with native Job-empty receipts and `jobsQuiescent:true`, and one `review` evidence row with verdict `pass`. It did **not** close: no `command` evidence row exists and the request budget was exhausted, so `chain_close_round` could not run in that round.

Root cause, recorded honestly: the work agent could not observe integer exit codes - `chain_compute` returns at launch, `job_output` is fenced inside a controlled round, `chain_status` was forbidden by that round's prompt, and the `command` layer demanded an integer the agent did not have. Work recorded a `self-report` instead of inventing exit codes.

Fix in `.14`: `chain_record_evidence` accepts `{jobId}` for `command` evidence and derives `command`, integer `exitCode`, `evidenceRef` and `outcome` from the recorded job execution, refusing unknown (`BAD_ARGS`), unsettled (`JOB_NOT_SETTLED`) and exit-less (`JOB_EXIT_UNKNOWN`) jobs. New deterministic test covers the derivation and all three refusals. Deterministic: **72/72** main, routes 58/58, api 38/38.

Evidence: `C:\Users\Weihao Chen\Desktop\DSH\r4s-20261104T2000\logs\evidence\` (`state-r4s-a.json`, job directories, host logs).

Verdict remains **PARTIAL / NOT DEPLOYABLE**.

## Budget-admission forensics and hardening (.15)

Correction of an earlier assistant statement: round `R-d0ca7610` (r4u) did **not** exceed its token authorization.
The reported "653,736 tokens" came from double counting in an ad-hoc audit (summing the disjoint
`inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` **and** `totalTokens`). Re-reading the same
23 request rows gives **326,868 total tokens** (65.4% of the 500,000 authorization) — every row's components
sum exactly to its `totalTokens` (e.g. 3854 + 432 + 3584 + 0 = 7870).

- No admission refusal occurred in r4u: the round ended normally after the plan turn with 23/24 requests and
  1 request left. The "attempt limit exhausted" message quoted earlier belonged to an earlier round.
- Admission path (verified in code): `lib/usage.js` `reserveRequest` runs inside `store.mutate` (cross-process
  exclusive lock), rejects at `requests.length >= limits.requests`, at `maxTokens > outputCap`, at
  `totals.totalTokens + totals.pendingReserved + reservedTokens > limits.tokens`, and additionally calls
  `assertProjectAdmission(state, now, reservedTokens)` for the project-wide deadline, request cap and
  settled + pending + new reservation token check. Pending reservations are therefore counted atomically;
  unknown-outcome rows keep their reservation; terminal failures without usage are charged at the reservation
  upper bound (`chargeTokens`) rather than zero.
- New deterministic file `test/budget-admission.mjs` (6 tests, all pass) proves: a pending reservation blocks a
  concurrent admission; settled usage plus pending reservations gate the next request; a settlement **above** its
  reservation is charged and blocks the next request; an unknown receipt keeps the reservation (never zero);
  a rebuilt `RoundStore` on the same directory still refuses (restart recovery); failed attempts consume request
  slots and N+1 is refused.
- Residual, explicitly not a hard bound: `reservedTokens = inputEstimate + outputCap` where `inputEstimate` is a
  JSON-byte estimate, not provider tokenization. A single request whose true input exceeds its estimate can be
  charged above its reservation at settlement time; the ledger then records the true usage and blocks every
  later request, but the overshoot of that one request is not prevented by the reservation. Money remains
  `unknown` because no provider invoice is available; reservations are not treated as billed cost.

Deterministic totals after this change: main suite 79/79, `test/routes.mjs` 58/58, `test/api.mjs` 38/38.

## Lifecycle finding, bounded in-call wait, and Host-completion preference (.16, 2026-11-04 +08:00)

Cause of the r4v loss (`J-2bd7ee97` / `J-716989ce`, both `stopped/137`, `owner disposed`) is now traced
in the installed Host and in this plugin:

- `@deepseek-ai/dsh-jobs` contract (`lib/index.js:83-105`): registrations outlive producer and controller
  fibers, and **"owner and service disposal cancel live work and await compliant producers"**. A job is owned
  by `execution.ownerSessionId` (`plugins/l2-protocol/lib/managed-jobs.js:87`), i.e. the work agent's session;
  when that agent is disposed at the end of its turn, the Host disposes its owned jobs — the exact
  `owner disposed` stop recorded at 14:32:29Z.
- The native receipt is written by the supervisor after the Windows Job is empty
  (`plugins/l2-protocol/lib/windows-supervisor.ps1`), then read through `readJobProof`
  (`plugins/l2-protocol/lib/managed-jobs.js:36-59`); `live.settlement`
  (`managed-jobs.js:97-121`) resolves only after the supervisor process exit **and** that receipt.
- Therefore the previous design (return at launch, expect a later turn to poll) had no lawful wait: the owner
  was allowed to be released before its job settled.

Fix (candidate only, not installed):

- `plugins/l2-protocol/lib/controller.js` adds `raceSettled()` and `waitForSettled()`; `compute()` accepts
  `waitMs` and now prefers the Host's own completion notification (`live.settlement`) inside the same tool
  call, falling back to a bounded ledger check only when no live handle exists. `dispatch()` also accepts
  `waitMs` for a bounded child wait. Neither consumes a model request; on timeout the result is
  `settled:false` and nothing is fabricated.
- `plugins/l2-protocol/lib/tools.js` exposes `waitMs` (0–600000) on `chain_compute` and `chain_dispatch`.

Evidence level (explicit): deterministic fixtures plus **real native Windows Job objects** through the real
`windows-supervisor.ps1` and real subprocess provider (`test/windows.mjs`): a job that exits 7 settles inside
the call and returns `exitCode:7`, `jobsQuiescent:true`, captured stdout `WAIT_OK`; a slow job returns
`settled:false` and remains supervised until cancelled, after which `jobsQuiescent:true` and
`outcome:cancelled` are observed. It is **not** yet observed through the live Host tool entry with a real
model turn; that remains the next real-round check. Suite after the change: 29/29 for
windows+control+smoke; full deterministic run below.

### Default bounded wait for guest-runner compute (.16 follow-up)

- `chain_compute` now waits by default when a guest runner is configured: `args.waitMs === undefined`
  resolves to 45000 ms (explicit `0` restores fire-and-forget, explicit values clamp to 0–600000). The
  wait prefers the Host job settlement notification (`live.settlement`, which resolves only after the
  supervisor exit and the native Job-empty receipt) and falls back to a bounded durable-ledger check.
- The tool schema now exposes `waitMs` on `chain_compute`, so a model turn can ask for a different bound.
- Consequence for the orchestration: the work completion that starts a compute also receives its real
  `exitCode`, `outcome` and receipt reference, so the next completion can record `command` evidence by
  `jobId` without any `chain_status` polling. Plan therefore needs no status-poll loop to learn completion.
- Verified at native level: `test/windows.mjs` (real native Windows Job + real `windows-supervisor.ps1`)
  PASS lines include "same-call bounded wait returns the real exit code…" (exit 7, `jobsQuiescent:true`,
  stdout `WAIT_OK`) and "bounded wait timeout reports unsettled and leaves the job under supervision until
  cancelled" (settled false, then `outcome` prefix `cancelled`, `jobsQuiescent:true`).
- Not yet verified: the live Host tool entry with a real model turn; and a wait used by plan's
  `chain_dispatch` (left opt-in to avoid changing dispatch timing without evidence).

## `.17` - evidence interface repair (r5 candidate, not deployed)

Triggered by the A-segment finding on `.16` (r4w round `R-5c343e98`): a real work turn could not
register command evidence by the id `chain_compute` had just returned.

**Correction of an earlier statement (recorded honestly).** Saying "argv was never persisted" was
imprecise. `managed-jobs.js` already wrote `spec.json` — which contains the confined `argv` the
supervisor then executed — into `executions/<roundId>/<executionId>/`. What was missing was the argv on
the **ledger execution record** (`e.spec`), and that record is what `commandEvidencePayload` read. So the
second error (`Pass command or bind a job that recorded its argv.`) was a ledger-record gap, not the
absence of any on-disk record. The first error (`jobId must name a compute job in this round.`) was a
pure identifier mismatch: `chain_compute` returns the Host job id (`role-chain-compute-<hex>`), while
`round.executions` is keyed by `J-<uuid>` and the old resolver only did a key lookup.

Fix: `resolveComputeJob` accepts either id (key first, then `execution.jobId`, cross-round → `JOB_WRONG_ROUND`);
`launchManagedJob` records `e.spec = { requested, argv, cwd, label }`; `commandEvidencePayload` derives
`command`/`exitCode`/`outcome` from that record and its native receipt, refuses unproven jobs
(`JOB_PROOF_MISSING`), refuses caller values that disagree (`EVIDENCE_MISMATCH`), and returns
`jobId`/`hostJobId`/`executedCommand`/`evidenceRef`. `requested` (intent) and `argv` (scheduled fact) are
both kept so they cannot silently stand in for each other. No close-round gate was touched.

Tests: `test/evidence-interface.mjs` (4, fixture) and `test/evidence-native.mjs` (2, real Windows Job +
supervisor + receipt) are new; `test/smoke.mjs` tightened the cross-round assertion from `BAD_ARGS` to
`JOB_WRONG_ROUND`. Both new files run standalone (`node test/<file>.mjs`); the package has no npm scripts,
so they are not wired into a runner.

Independent read-only review verdict: **partial**. Accepted items applied here: corrected root cause,
`executedCommand`, tool-description contract. Remaining open items it raised: derived `command` joins argv
with single spaces so original quoting is not recoverable; a payload with no `jobId` still accepts a
caller-typed `command`+`exitCode` with no native binding (legacy path in `.17`; closed from `.18` by `COMMAND_BINDING_REQUIRED`); POSIX has no
coverage for the native file; same-round references to another session's job are not restricted; the real
Host/tool entry is still unproven for `.17`.

Still unproven for `.17`: any real model turn, `chain_stop`, cancel/timeout through the tool entry,
descendant-exit through the tool entry, a real review write refusal, and 9p hardlink read boundaries.

## .29 review fixes (independent review #15, verdict partial)

Review #15 found four real defects in the first .29 freeze. All are fixed; the tree was refrozen.

| Finding | Fix |
| --- | --- |
| Request-slot reserve off by one: `count + holdRequests > limit` let ordinary work take every slot | `count + 1 + holdRequests > limit`; the fixture now admits six ordinary requests for `requests: 8` and proves both closing slots remain |
| `CLOSEOUT_RESERVE_PROTECTED` was also raised when uncertainty alone blocked admission | the refusal now also requires the numeric `overHold` |
| `closeoutTimeMs` could be lowered in an authorized project (`closeoutRequests: 1`, `closeoutTimeMs: 1` admitted) | authorized rounds below `DEFAULT_CLOSEOUT_REQUESTS`/`DEFAULT_CLOSEOUT_TIME_MS` are refused with `BAD_BUDGET` |
| A durable .28 grant became `AUTHORIZATION_CORRUPT` because two new budget keys were compared | the comparison only checks keys the durable grant actually recorded |

Fixture suite: 94 cases, 0 failures. Native suite: 17 files (git 2, windows 1, evidence-native 1, bridge-live 10, guest-boundaries 8, api/routes exit 0), 0 failures.
Frozen manifest: 62 entries (at the .29 freeze); the digest is recorded only in `FILE-FINGERPRINTS.json` so this text never pins a stale one (recomputed by an independent walker, `match: true`, stable across a full suite run).

Still not covered by a fixture: a store with `requiresAuthorization` (`test/helpers.mjs` has no `authorityRoot`), so the openRound reserve floor, the project-level hold and the second-assert mapping are verified only by ad-hoc probes. The rehearsal transcript still prints `[object Object]` for two rows. This version remains PARTIAL and is not deployable.
