"""Shared test setup."""

import os
import uuid

import pytest
from dotenv import load_dotenv

import memory

# Local runs read keys from .env.local like the agent does. In CI the variables come
# from secrets, and load_dotenv never overrides a variable that is already set.
load_dotenv(".env.local")

needs_db = pytest.mark.skipif(
    not os.getenv("TEST_DATABASE_URL"), reason="no TEST_DATABASE_URL"
)


@pytest.fixture
async def db():
    conn = await memory.connect(os.environ["TEST_DATABASE_URL"])
    yield conn
    await conn.close()


@pytest.fixture
async def new_user(db):
    """Makes fresh user ids, so tests never see each other's rows, and cleans up."""
    made = []

    def make() -> str:
        made.append(f"test-{uuid.uuid4()}")
        return made[-1]

    yield make
    await db.execute("DELETE FROM tasks WHERE user_id = ANY(%s)", (made,))
    await db.execute("DELETE FROM facts WHERE user_id = ANY(%s)", (made,))
