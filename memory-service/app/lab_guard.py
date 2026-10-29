"""In lab mode, the service starts only against a Neo4j and a database on this machine.

The retrieval lab (scripts/benchmarks/retrieval-lab/ in the app repository) runs this service on
a developer's laptop: as its embedder, and with its graph leg as its memory service. graphiti_core
calls load_dotenv() when it is imported, which walks up from the virtualenv to the nearest .env,
and pydantic-settings reads memory-service/.env itself; either can hand the service a hosted
NEO4J_URI nobody set on the command line. Twice, that connected a lab run to a hosted Neo4j.

The one rule this module enforces: with WILLDER_LAB_MODE=1, the service talks only to this
machine. It is checked in two places. At startup, the service exits before it opens any connection
unless every NEO4J_URI and DATABASE_URL it can see is empty or names this machine. And where every
Neo4j driver is built (app/graphiti_client.py), the URI is checked again, so a connection is
refused whatever started the service. Outside lab mode a remote Neo4j is allowed; an empty
NEO4J_URI turns the graph off in every mode.

Two lab runs reached a hosted Neo4j through a .env nobody meant the service to read. The service
no longer reads one it did not name (app/__init__.py), and in lab mode it reads none
(app/config.py).
"""

import ipaddress
import sys
from collections.abc import Mapping
from urllib.parse import parse_qs, urlsplit

LAB_MODE_ENV = "WILLDER_LAB_MODE"

# The variables naming a server the service could connect to.
CHECKED_ENV = ("NEO4J_URI", "DATABASE_URL")

# libpq query parameters that override the host in the URI's authority.
_HOST_PARAMS = ("host", "hostaddr")


def _is_local_host(host: str) -> bool:
    """Whether one host, as written in a URI, is this machine: empty (a Unix socket), a socket
    path, `localhost`, or a loopback address. Any other name, however it starts, is not."""
    if host == "" or host.startswith("/"):
        return True
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _hosts_in_authority(netloc: str) -> list[str]:
    """The hosts of a URI's authority, without user info or ports: one, or several comma-separated
    as libpq allows (`host1:5432,host2:5432`)."""
    hosts = []
    for entry in netloc.rpartition("@")[2].split(","):
        if entry.startswith("["):
            hosts.append(entry[: entry.find("]") + 1])
        else:
            hosts.append(entry.partition(":")[0])
    return hosts


def is_local_uri(uri: str) -> bool:
    """Whether every host `uri` names is on this machine. An empty value names none. A value that
    is not a URI with an authority (`scheme://...`) is not local: it cannot be shown to be."""
    if uri == "":
        return True
    try:
        parts = urlsplit(uri)
    except ValueError:
        # An unbalanced or non-IP bracketed host: not a URI anything here would connect to.
        return False
    if not parts.scheme or not uri[len(parts.scheme) :].startswith("://"):
        return False
    hosts = _hosts_in_authority(parts.netloc)
    for name, values in parse_qs(parts.query).items():
        if name in _HOST_PARAMS:
            hosts.extend(host for value in values for host in value.split(","))
    return all(_is_local_host(host.strip()) for host in hosts)


def lab_mode(env: Mapping[str, str]) -> bool:
    """Whether `env` turns lab mode on. Only the value 1 does."""
    return env.get(LAB_MODE_ENV) == "1"


class GraphUnavailable(RuntimeError):
    """The service will not open a Neo4j connection with the URI it has."""


def connectable_neo4j_uri(uri: str, env: Mapping[str, str]) -> str:
    """`uri`, when a Neo4j driver may be opened with it. Raises GraphUnavailable when it is empty
    (the graph is off) or when `env` turns lab mode on and it names another machine.

    The message names the variable, never its value, which may carry a password.
    """
    if uri == "":
        raise GraphUnavailable("NEO4J_URI is empty: the memory graph is off in this process.")
    if lab_mode(env) and not is_local_uri(uri):
        raise GraphUnavailable(
            f"refusing to connect in lab mode ({LAB_MODE_ENV}=1): NEO4J_URI names a host that is "
            "not this machine. Point it at localhost, or leave it empty to turn the graph off."
        )
    return uri


def refuse_remote_in_lab_mode(env: Mapping[str, str], neo4j_uri: str) -> None:
    """Exit the process when `env` turns lab mode on and any of CHECKED_ENV in `env`, or
    `neo4j_uri` (the setting the service connects with), names another machine.

    The message names the variable, never its value, which may carry a password.
    """
    if not lab_mode(env):
        return
    named = [(name, env.get(name, "")) for name in CHECKED_ENV] + [
        ("the NEO4J_URI setting (env or memory-service/.env)", neo4j_uri)
    ]
    remote = [name for name, uri in named if not is_local_uri(uri)]
    if remote:
        print(
            f"memory-service: refusing to start in lab mode ({LAB_MODE_ENV}=1): {', '.join(remote)} "
            "names a host that is not this machine. Point it at localhost, or unset it.",
            file=sys.stderr,
        )
        raise SystemExit(2)
