"""The Willder memory service.

Its settings come from the process environment and, outside lab mode, memory-service/.env
(app/config.py), and from nowhere else. graphiti_core calls python-dotenv's load_dotenv() when
it is imported, which walks up from the virtualenv to the nearest .env: in a checkout, the app's
root .env, which can name a hosted Neo4j. That walk connected two local lab runs to one
(app/lab_guard.py). It is turned off here, before any module of the service imports graphiti_core.
Production sets its variables in the environment and ships no .env, so nothing there changes.
"""

import os

os.environ["PYTHON_DOTENV_DISABLED"] = "1"
