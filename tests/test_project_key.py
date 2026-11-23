"""project_key: a worktree's .git file must resolve to the main repo, so worktrees of one
repo share the repo key and different repos do not."""
import os
import subprocess

from coordinate import queue as q


def repo(tmp_path):
    d = tmp_path / "main"
    d.mkdir(parents=True)
    subprocess.run(["git", "-C", str(d), "init", "-q"], check=True)
    subprocess.run(["git", "-C", str(d), "commit", "--allow-empty", "-qm", "init"],
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}, check=True)
    return d


def test_plain_repo_key(tmp_path):
    d = repo(tmp_path)
    assert q.project_key(str(d)) == str(d)


def test_worktree_shares_main_repo_key(tmp_path):
    d = repo(tmp_path)
    wt = tmp_path / "wt"
    subprocess.run(["git", "-C", str(d), "worktree", "add", "-q", str(wt)], check=True)
    assert (wt / ".git").is_file()  # the bug precondition: .git is a file, not a dir
    assert q.project_key(str(wt)) == str(d)
    assert q.project_key(str(d)) == q.project_key(str(wt))


def test_two_repos_do_not_share(tmp_path):
    d1 = repo(tmp_path)
    d2 = repo(tmp_path / "b")
    w1 = tmp_path / "w1"
    subprocess.run(["git", "-C", str(d1), "worktree", "add", "-q", str(w1)], check=True)
    keys = {q.project_key(str(p)) for p in (d1, w1, d2)}
    assert len(keys) == 2
    assert q.project_key(str(w1)) == q.project_key(str(d1))
    assert q.project_key(str(d2)) != q.project_key(str(d1))


def test_non_repo_falls_back_to_cwd(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    assert q.project_key(str(plain)) == str(plain)


def test_worktree_via_git_probe(tmp_path):
    """A fake git probe stands in for `git rev-parse --git-common-dir`."""
    d = repo(tmp_path)
    wt = tmp_path / "wt2"
    wt.mkdir()

    def probe(cmd, **kw):
        class R:
            returncode = 0
            stdout = str(d / ".git") + "\n"
        return R()

    (wt / ".git").write_text("gitdir: /bogus/path\n")
    assert q._worktree_main_repo(str(wt), str(wt / ".git"), _probe=probe) == str(d)


def test_probe_gets_2s_timeout(tmp_path):
    seen = {}

    def probe(cmd, **kw):
        seen.update(kw)
        import subprocess
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))

    d = repo(tmp_path)
    assert q._worktree_main_repo(str(d), "/nonexistent/.git", _probe=probe) is None
    assert seen.get("timeout") == 2
