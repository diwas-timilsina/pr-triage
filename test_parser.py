#!/usr/bin/env python3
"""Edge-case tests for pr-triage's diff parser and heuristics."""
import importlib.machinery
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_loader(
    "prt", importlib.machinery.SourceFileLoader("prt", os.path.join(HERE, "pr-triage")))
prt = importlib.util.module_from_spec(spec)
sys.modules["prt"] = prt
spec.loader.exec_module(prt)

TRICKY = r'''diff --git a/src/app.py b/src/app.py
index 1111111..2222222 100644
--- a/src/app.py
+++ b/src/app.py
@@ -1,4 +1,5 @@ def main():
 import os
+import sys

 def main():
-    return 1
+    return 2
@@ -20,3 +21,3 @@ class Foo:
-    x=1
+    x = 1
\ No newline at end of file
diff --git a/old_name.py b/new_name.py
similarity index 100%
rename from old_name.py
rename to new_name.py
diff --git a/img/logo.png b/img/logo.png
index 3333333..4444444 100644
Binary files a/img/logo.png and b/img/logo.png differ
diff --git a/uv.lock b/uv.lock
index 5555555..6666666 100644
--- a/uv.lock
+++ b/uv.lock
@@ -10,2 +10,3 @@
 version = "1.0"
+revision = 3
 requires-python = ">=3.11"
diff --git "a/docs/with space.md" "b/docs/with space.md"
index 7777777..8888888 100644
--- "a/docs/with space.md"
+++ "b/docs/with space.md"
@@ -1 +1,2 @@
 # Title
+more docs
diff --git a/brand_new.py b/brand_new.py
new file mode 100644
index 0000000..9999999
--- /dev/null
+++ b/brand_new.py
@@ -0,0 +1,2 @@
+def hello():
+    return "world"
diff --git a/goodbye.py b/goodbye.py
deleted file mode 100644
index aaaaaaa..0000000
--- a/goodbye.py
+++ /dev/null
@@ -1,2 +0,0 @@
-def bye():
-    return None
'''

failures = []


def check(name, cond, detail=""):
    status = "ok" if cond else "FAIL"
    print(f"  {status}: {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


files = prt.parse_diff(TRICKY)
by_path = {f.display_path: f for f in files}

check("7 files parsed", len(files) == 7, f"got {len(files)}: {list(by_path)}")

app = by_path.get("src/app.py")
check("app.py has 2 hunks", app and len(app.hunks) == 2,
      f"got {len(app.hunks) if app else None}")
check("hunk1 counts +2/-1", app and app.hunks[0].added == 2 and app.hunks[0].removed == 1,
      f"got +{app.hunks[0].added}/-{app.hunks[0].removed}" if app else "")
check("hunk1 new_start=1 count=5", app and app.hunks[0].new_start == 1 and app.hunks[0].new_count == 5)
check("no-newline marker kept in hunk2", app and "\\ No newline" in app.hunks[1].body)

ren = by_path.get("old_name.py -> new_name.py")
check("rename detected", ren is not None and ren.is_rename, f"paths: {list(by_path)}")
check("pure rename has no hunks", ren is not None and not ren.hunks)
check("rename classified as noise", ren is not None and prt.classify_noise(ren) is not None)

png = by_path.get("img/logo.png")
check("binary detected", png is not None and png.is_binary)
check("binary classified as noise", png is not None and prt.classify_noise(png) is not None)

lock = by_path.get("uv.lock")
check("lockfile parsed with hunk", lock is not None and len(lock.hunks) == 1)
noise = prt.classify_noise(lock) if lock else None
check("uv.lock classified as lockfile noise", noise is not None and noise[1] == "dependency")

spaced = by_path.get("docs/with space.md")
check("quoted path with space parsed", spaced is not None and len(spaced.hunks) == 1)

new = by_path.get("brand_new.py")
check("new file detected", new is not None and new.is_new and new.status == "added")
dele = by_path.get("goodbye.py")
check("deleted file detected", dele is not None and dele.is_deleted and dele.status == "deleted")
check("deleted file hunk keeps old path", dele is not None and dele.hunks
      and dele.hunks[0].file == "goodbye.py")

# whitespace heuristic: conservative — only TRAILING whitespace diffs qualify
ws_hunk = app.hunks[1] if app else None
check("x=1 -> x = 1 goes to model (internal whitespace can be semantic)",
      ws_hunk is not None and not prt.is_whitespace_only(ws_hunk))
real_hunk = app.hunks[0] if app else None
check("real change is NOT whitespace-only", real_hunk is not None and not prt.is_whitespace_only(real_hunk))
mk = lambda body: prt.Hunk(hid="T", file="t.py", file_status="modified", header="@@", body=body)
check("trailing-ws-only IS whitespace-only",
      prt.is_whitespace_only(mk("@@ -1 +1 @@\n-x = 1   \n+x = 1")))
check("indentation change NOT whitespace-only (dedent changes behavior)",
      not prt.is_whitespace_only(mk("@@ -1,2 +1,2 @@\n     if x:\n-        do()\n+    do()")))
check("line merge NOT whitespace-only",
      not prt.is_whitespace_only(mk("@@ -1,2 +1 @@\n-foo\n-bar\n+foobar")))

# ids assigned sequentially across files
all_ids = [h.hid for f in files for h in f.hunks]
check("hunk ids unique", len(all_ids) == len(set(all_ids)))

# PR ref parsing
check("url parse", prt.parse_pr_ref("https://github.com/Nextdoor/dataflow/pull/945", None)
      == ("Nextdoor/dataflow", 945))
check("url with trailing junk", prt.parse_pr_ref(
    "https://github.com/Nextdoor/dataflow/pull/945/files#diff-abc", None) == ("Nextdoor/dataflow", 945))
check("short form", prt.parse_pr_ref("Nextdoor/dataflow#945", None) == ("Nextdoor/dataflow", 945))

# extract_json robustness
check("bare json", prt.extract_json('{"scores": []}') == {"scores": []})
check("fenced json", prt.extract_json('```json\n{"scores": [{"id":"H1"}]}\n```')["scores"][0]["id"] == "H1")
check("prose-wrapped json", prt.extract_json('Sure!\n{"scores": []}\nDone.') == {"scores": []})
check("nested braces", prt.extract_json('x {"scores": [], "m": {"a": "}b{"}} y')["m"]["a"] == "}b{")
check("brace inside string value",
      prt.extract_json('{"scores":[{"id":"H1","reason":"moves the } bracket handling"}]}')
      ["scores"][0]["id"] == "H1")
check("unmatched { inside string",
      prt.extract_json('{"scores":[{"id":"H2","reason":"adds { opener"}]}')["scores"][0]["id"] == "H2")
check("prose braces before payload",
      prt.extract_json('Sure, {here} it is: {"scores": []}') == {"scores": []})
check("escaped quote before brace",
      prt.extract_json('{"scores":[],"a":"\\"}"}')["a"] == '"}')

# fixed parser bugs: regression coverage
ff = prt.parse_diff('diff --git a/page.el b/page.el\n--- a/page.el\n+++ b/page.el\n'
                    '@@ -1,3 +1,3 @@\n \x0c;; page two\n-old_line\n+new_line\n')
check("form feed inside content does not truncate hunk",
      len(ff) == 1 and ff[0].hunks[0].added == 1 and ff[0].hunks[0].removed == 1)

modeonly = prt.parse_diff('diff --git a/deploy.sh b/deploy.sh\nold mode 100644\nnew mode 100755\n')
check("mode-only change captured", len(modeonly) == 1 and not modeonly[0].hunks
      and modeonly[0].old_mode == "100644" and modeonly[0].new_mode == "100755")

copied = prt.parse_diff('diff --git a/orig.py b/copy.py\nsimilarity index 100%\n'
                        'copy from orig.py\ncopy to copy.py\n')
check("pure copy detected", len(copied) == 1 and copied[0].is_copy
      and copied[0].status == "copied" and prt.classify_noise(copied[0]) is not None)

quoted = prt.parse_diff('diff --git "a/caf\\303\\251/x.py" "b/caf\\303\\251/x.py"\n'
                        '--- "a/caf\\303\\251/x.py"\n+++ "b/caf\\303\\251/x.py"\n'
                        '@@ -1 +1 @@\n-a\n+b\n')
check("git C-quoted unicode path decoded",
      len(quoted) == 1 and quoted[0].new_path == "café/x.py", f"got {quoted[0].new_path if quoted else None}")

delrange = prt.parse_diff('diff --git a/gone.py b/gone.py\ndeleted file mode 100644\n'
                          '--- a/gone.py\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n-b\n-c\n')
check("deleted-file hunk shows 'deleted' not ':0'",
      delrange[0].hunks[0].line_range == "deleted")

# clean env: session markers stripped, auth/backend vars kept
os.environ.update({"CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli",
                   "CLAUDE_CODE_OAUTH_TOKEN": "tok", "CLAUDE_CODE_USE_BEDROCK": "1"})
env = prt.clean_claude_env()
check("session markers stripped", "CLAUDECODE" not in env and "CLAUDE_CODE_ENTRYPOINT" not in env)
check("auth/backend vars preserved",
      env.get("CLAUDE_CODE_OAUTH_TOKEN") == "tok" and env.get("CLAUDE_CODE_USE_BEDROCK") == "1")

# html templating: single-pass substitution (token smuggling via PR title/branch)
class FakeOpts:
    model = None
meta_evil = {"number": 7, "title": "evil __CARDS__ __PR_KEY__ title", "url": "https://github.com/o/r/pull/7",
             "headRefName": "__TITLE__", "baseRefName": "main", "changedFiles": 1,
             "additions": 1, "deletions": 1}
one = prt.parse_diff('diff --git a/real.py b/real.py\n--- a/real.py\n+++ b/real.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n')
h1 = one[0].hunks[0]
h1.importance, h1.category, h1.reason = 80, "logic", "r"
doc = prt.render_html(meta_evil, [h1], FakeOpts())
check("smuggled __CARDS__ not expanded (exactly 1 card)", doc.count("<details") == 1,
      f"got {doc.count('<details')}")
check("smuggled token stays literal text", "evil __CARDS__ __PR_KEY__ title" in doc)
check("card data-id is content hash", f'data-id="{prt.stable_hid(h1)}"' in doc
      and prt.stable_hid(h1).startswith("h") and len(prt.stable_hid(h1)) == 13)

print()
if failures:
    print(f"{len(failures)} FAILURES: {failures}")
    sys.exit(1)
print("all parser tests passed")
