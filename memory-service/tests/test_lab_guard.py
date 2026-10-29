"""The lab-mode startup guard (app/lab_guard.py): in lab mode the service exits before it
opens any connection unless every NEO4J_URI and DATABASE_URL it can see names this machine.

The incident it closes: graphiti_core's load_dotenv() read a checkout's root .env and pointed a
lab embedder at a hosted Neo4j, which ran one read query."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import lab_guard, main
from app.config import settings

LOCAL = [
    "",
    "bolt://127.0.0.1:1",
    "bolt://localhost:7687",
    "neo4j://LOCALHOST:7687",
    "bolt://[::1]:7687",
    "bolt://127.0.0.2:7687",
    "postgresql://lab@127.0.0.1:55613/lab_base",
    "postgresql://lab@/lab_base",
    "postgresql:///lab_base?host=/tmp",
    "postgresql://lab@localhost:5432,127.0.0.1:5433/lab_base",
]

REMOTE = [
    "neo4j+s://abc123.databases.neo4j.io",
    "bolt://neo4j:secret@graph.example.com:7687",
    "bolt://localhost.example.com:7687",
    "bolt://127.0.0.1.nip.io:7687",
    "bolt://0.0.0.0:7687",
    "bolt://10.0.0.5:7687",
    "postgresql://u@db.example.com/x",
    "postgresql://u@127.0.0.1/x?host=db.example.com",
    "postgresql://u@127.0.0.1/x?hostaddr=10.1.2.3",
    "postgresql://u@127.0.0.1/x?host=localhost,db.example.com",
    "postgresql://u@127.0.0.1:5432,db.example.com:5432/x",
    "graph.example.com:7687",
    "not a uri",
    "bolt://[graph.example.com]:7687",
    "bolt://[::1",
    "postgresql://u:p@[x",
]


@pytest.mark.parametrize("uri", LOCAL)
def test_a_uri_on_this_machine_is_local(uri):
    assert lab_guard.is_local_uri(uri)


@pytest.mark.parametrize("uri", REMOTE)
def test_a_uri_naming_any_other_host_is_not(uri):
    assert not lab_guard.is_local_uri(uri)


def test_outside_lab_mode_nothing_is_refused():
    lab_guard.refuse_remote_in_lab_mode(
        {"NEO4J_URI": "neo4j+s://abc.databases.neo4j.io"}, "neo4j+s://abc.databases.neo4j.io"
    )


@pytest.mark.parametrize("name", ["NEO4J_URI", "DATABASE_URL"])
def test_lab_mode_refuses_a_remote_uri_in_the_environment_naming_the_variable_not_its_value(
    name, capsys
):
    env = {lab_guard.LAB_MODE_ENV: "1", name: "neo4j+s:" + "//user:hunter2@abc.databases.neo4j.io"}
    with pytest.raises(SystemExit) as exited:
        lab_guard.refuse_remote_in_lab_mode(env, "")
    assert exited.value.code != 0
    err = capsys.readouterr().err
    assert name in err
    assert "hunter2" not in err and "abc.databases" not in err


def test_lab_mode_refuses_a_remote_neo4j_the_settings_read_from_a_dotenv_file():
    """pydantic-settings reads memory-service/.env itself, without touching os.environ."""
    with pytest.raises(SystemExit):
        lab_guard.refuse_remote_in_lab_mode(
            {lab_guard.LAB_MODE_ENV: "1"}, "neo4j+s://abc.databases.neo4j.io"
        )


def test_lab_mode_starts_against_local_and_unset_uris():
    env = {lab_guard.LAB_MODE_ENV: "1", "NEO4J_URI": "bolt://127.0.0.1:1", "DATABASE_URL": ""}
    lab_guard.refuse_remote_in_lab_mode(env, "bolt://127.0.0.1:1")


@pytest.mark.parametrize("value", ["true", "yes", "0", ""])
def test_only_the_value_1_turns_lab_mode_on(value):
    lab_guard.refuse_remote_in_lab_mode(
        {lab_guard.LAB_MODE_ENV: value, "NEO4J_URI": "bolt://graph.example.com"}, ""
    )


def _record_warmups(monkeypatch) -> list[bool]:
    started: list[bool] = []

    async def warmup():
        started.append(True)

    monkeypatch.setattr(main, "_warmup", warmup)
    return started


def test_the_service_exits_at_startup_in_lab_mode_before_it_opens_a_connection(tmp_path):
    """The real process, as the lab starts it: uvicorn exits with a failure and the guard's
    message, and the warmup that opens the Neo4j connection never logs a start."""
    env = {
        "PATH": os.environ["PATH"],
        "HOME": os.environ.get("HOME", str(tmp_path)),
        "HF_HUB_OFFLINE": "1",
        lab_guard.LAB_MODE_ENV: "1",
        # A name that resolves nowhere: were the guard gone, the warmup would only fail to connect.
        "NEO4J_URI": "bolt://graph.invalid:7687",
        "DATABASE_URL": "",
        "GRAPHITI_SERVICE_API_KEY": "lab-local",
    }
    service_dir = Path(__file__).resolve().parent.parent
    done = subprocess.run(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "0"],
        cwd=service_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode != 0
    assert "refusing to start in lab mode" in done.stderr
    assert "NEO4J_URI" in done.stderr
    assert "graph.invalid" not in done.stderr


def test_the_service_starts_in_lab_mode_against_a_local_neo4j(monkeypatch):
    started = _record_warmups(monkeypatch)
    monkeypatch.setenv(lab_guard.LAB_MODE_ENV, "1")
    monkeypatch.setenv("NEO4J_URI", "bolt://127.0.0.1:1")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(settings, "neo4j_uri", "bolt://127.0.0.1:1")
    with TestClient(main.app) as client:
        assert client.get("/health").status_code == 200
    assert started == [True]


# --- The same rule where every Neo4j driver is built ---
#
# The startup check above runs only when the service was started with WILLDER_LAB_MODE=1. On
# 2026-10-15 a lab embedder was started without it, read the checkout's root .env and connected
# to the hosted Neo4j again. These tests pin the two controls that do not depend on remembering
# a flag: the driver constructors check the URI themselves, and no import reads a .env the
# service did not name.


def test_the_constructor_refuses_a_remote_uri_in_lab_mode_naming_the_variable_not_its_value():
    with pytest.raises(lab_guard.GraphUnavailable) as refused:
        lab_guard.connectable_neo4j_uri(
            "neo4j+s://neo4j:hunter2@abc.databases.neo4j.io", {lab_guard.LAB_MODE_ENV: "1"}
        )
    message = str(refused.value)
    assert "NEO4J_URI" in message and lab_guard.LAB_MODE_ENV in message
    assert "hunter2" not in message and "abc.databases" not in message


@pytest.mark.parametrize(
    "uri", ["bolt://127.0.0.1:7687", "bolt://localhost:7687", "bolt://[::1]:7687"]
)
def test_the_constructor_allows_a_loopback_uri_in_lab_mode(uri):
    assert lab_guard.connectable_neo4j_uri(uri, {lab_guard.LAB_MODE_ENV: "1"}) == uri


def test_the_constructor_allows_a_remote_uri_outside_lab_mode():
    """Production connects to AuraDB; only lab mode restricts the host."""
    uri = "neo4j+s://abc.databases.neo4j.io"
    assert lab_guard.connectable_neo4j_uri(uri, {}) == uri


@pytest.mark.parametrize("env", [{}, {lab_guard.LAB_MODE_ENV: "1"}])
def test_an_empty_uri_turns_the_graph_off_by_name(env):
    with pytest.raises(lab_guard.GraphUnavailable, match="NEO4J_URI is empty"):
        lab_guard.connectable_neo4j_uri("", env)


def _neo4j_drivers_opened(monkeypatch) -> list[str]:
    """Replace the neo4j library's driver factory, so a test sees every URI the service would
    open a driver with and nothing reaches a network."""
    from app import graphiti_client

    opened: list[str] = []

    def driver(uri, **_):
        opened.append(uri)
        raise AssertionError("a driver was opened")

    monkeypatch.setattr(graphiti_client.AsyncGraphDatabase, "driver", driver)
    return opened


@pytest.mark.parametrize("constructor", ["open_driver", "open_graph_driver"])
def test_neither_driver_constructor_opens_a_remote_uri_in_lab_mode(monkeypatch, constructor):
    """Every Neo4j connection the service makes goes through one of these two. Lab mode turned
    on after startup, the path the startup check cannot see, is refused here."""
    import asyncio

    from app import graphiti_client

    opened = _neo4j_drivers_opened(monkeypatch)
    monkeypatch.setenv(lab_guard.LAB_MODE_ENV, "1")
    monkeypatch.setattr(settings, "neo4j_uri", "neo4j+s://abc.databases.neo4j.io")
    with pytest.raises(lab_guard.GraphUnavailable):
        result = getattr(graphiti_client, constructor)()
        if asyncio.iscoroutine(result):
            asyncio.run(result)
    assert opened == []


@pytest.mark.parametrize("constructor", ["open_driver", "open_graph_driver"])
def test_neither_driver_constructor_opens_an_empty_uri(monkeypatch, constructor):
    import asyncio

    from app import graphiti_client

    opened = _neo4j_drivers_opened(monkeypatch)
    monkeypatch.delenv(lab_guard.LAB_MODE_ENV, raising=False)
    monkeypatch.setattr(settings, "neo4j_uri", "")
    with pytest.raises(lab_guard.GraphUnavailable):
        result = getattr(graphiti_client, constructor)()
        if asyncio.iscoroutine(result):
            asyncio.run(result)
    assert opened == []


def _start_python(code: str, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess:
    service_dir = Path(__file__).resolve().parent.parent
    base = {
        "PATH": os.environ["PATH"],
        "HOME": os.environ.get("HOME", str(cwd)),
        "HF_HUB_OFFLINE": "1",
        "PYTHONPATH": str(service_dir),
    }
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=cwd,
        env=base | env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_importing_the_service_never_loads_a_dotenv_file_it_did_not_name(tmp_path):
    """graphiti_core calls load_dotenv() at import, which walks up from the virtualenv to the
    nearest .env: in a checkout, the app's own root .env, which names the hosted Neo4j. That walk
    is what connected both lab runs. The service turns it off for every start, lab mode or not;
    production sets its variables in the process environment and ships no .env."""
    (tmp_path / ".env").write_text(
        "NEO4J_URI=neo4j+s://abc.databases.neo4j.io\nWALKED_UP_DOTENV=read\n"
    )
    code = (
        "import os, dotenv\n"
        "import app.main\n"
        "import graphiti_core.helpers\n"
        "dotenv.load_dotenv(dotenv.find_dotenv(usecwd=True))\n"
        "print(os.environ.get('WALKED_UP_DOTENV', 'unread'))\n"
    )
    done = _start_python(code, tmp_path, {})
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip().splitlines()[-1] == "unread"


def test_lab_mode_settings_do_not_read_the_services_own_dotenv(tmp_path):
    """Outside lab mode, memory-service/.env is how a developer configures the service. In lab mode
    every value comes from the command line, so a .env next to it cannot name a hosted Neo4j."""
    (tmp_path / ".env").write_text("NEO4J_URI=neo4j+s://abc.databases.neo4j.io\n")
    code = "from app.config import settings\nprint(repr(settings.neo4j_uri))\n"
    in_lab = _start_python(code, tmp_path, {lab_guard.LAB_MODE_ENV: "1"})
    outside = _start_python(code, tmp_path, {})
    assert in_lab.returncode == 0, in_lab.stderr
    assert in_lab.stdout.strip() == "''"
    assert outside.stdout.strip() == "'neo4j+s://abc.databases.neo4j.io'"
