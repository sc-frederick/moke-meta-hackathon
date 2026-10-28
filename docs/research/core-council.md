# Core implementation council

Base: `a1d4bbc21` (includes merged SAM implementation, PR #5). Round 1 reviewed
`b73424d9c`, including the original local units 0–6 implementation and live evidence.
Optional Modal/cloud remains outside scope. All reviews were read-only, without
paid calls, nested agents, commits or PR watches.

| Delegate          | Round 1 | Round 2 | Final verdict |
| ----------------- | ------- | ------- | ------------- |
| GPT-6.1 Sol, high | 7/10    | 9/10    | Approve       |
| Grok 4.7, high    | 7/10    | 9/10    | Approve       |
| Composer 2.5      | 8.5/10  | 8.5/10  | Approve       |

## Findings ledger

| ID  | Severity | Resolution and proof                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | blocker  | A durable replacement journal blocks public writes and maintenance until startup recovery. Notes check the barrier inside the SQL permit, including unreadable journals. The application test leaves the incoming DB installed, rejects new notes/projects, reopens to the original, and proves later commits survive another reopen. Maintenance finalizers run while holding their own maintenance permit. |
| S2  | should   | Owner generation is excluded from semantic tool receipt identity and remains mandatory for new mutations. The real parent-port test replays a committed proposal with a new generation after correction; changed inputs still conflict.                                                                                                                                                                      |
| S3  | should   | Rollback persists `reverting` plus the saved original's hash and size before renames. It recognizes an original already returned to its live path by that identity. Tests cut before discard, after discard and after original return; a wrong identity blocks without changing the original.                                                                                                                |
| G1  | should   | Check inputs/dependencies now contain only facts passed to evaluation. Changed/unconfirmed correspondence explicitly explains rejected accepted inputs. The backend RPC test checks null rejected operand and a single current dependency.                                                                                                                                                                   |
| G2  | should   | Confirmed links are immutable and one-to-one in both command policy and migration 0006 indexes/triggers. Unconfirmed proposals have separate append-only history, allowing later confirmation without rewriting a link. Reassociation/ambiguous successor commands are rejected. Current-source traversal also rejects ambiguous graphs.                                                                     |
| G3  | should   | A confirmed destination cannot be unconfirmed later in the same association transaction. The RPC test creates a finding already on Rev B before association and verifies that destination stays confirmed.                                                                                                                                                                                                   |
| G4  | nit      | Transition checks `changes()=1`; a missed version rolls back its transaction and appends no phantom event. Focused persistence test covers the miss.                                                                                                                                                                                                                                                         |
| C1  | should   | Unix session files reject group/other permissions before reading credentials, using the same open handle for stat/read. Tests cover private files, shared permissions and canonical-route rejection. Windows retains its ACL-based permissions model.                                                                                                                                                        |
| C2  | nit      | Deferred environment allowlisting for the PDF worker. It is a trusted same-user subprocess with required OS/font/native-loader environment; it is not an OS security sandbox. Provider configuration uses the private startup channel. A narrower environment should be validated on all three packaging targets as separate hardening.                                                                      |
| C3  | nit      | Retained initial execution replay. The workbench's domain-event cursor is a different sequence and cannot replace the execution cursor. Initial replay reconstructs the latest finding run after reopening; reads paginate at 200. A dedicated execution snapshot/cursor would be a separate scale improvement.                                                                                              |
| C4  | doc nit  | Updated the stale NotesRpc-only comment to the restricted review/chooser boundary.                                                                                                                                                                                                                                                                                                                           |

Sol-loop used the single Sol member in two rounds and ended approved. Round 2
checked changed code and the open findings, all of which were resolved or accepted
as deferred nits. Sol independently passed 16 focused tests /152 assertions in
round 2; reviewer provider usage was not exposed. The behavior diff grew from
86 files /18,649 insertions at the first freeze to 91 files /19,414 insertions at
the second, primarily regression tests, recovery fixes, provenance and evidence.

Composer C5 (nit) proposed rejecting credential-file symlinks. Deferred: stat and
read use the same opened handle and enforce the target's permissions. An alias
to a private target does not bypass that check; the caller explicitly selects
the session path. No should/blocker findings remain. Final review freeze was
`a81b45226`; subsequent edits only record these review results.
