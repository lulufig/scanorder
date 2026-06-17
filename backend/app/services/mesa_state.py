"""
Estado operativo liviano de salón (ocupada / cuenta_solicitada / mozo_solicitado).
Se mantiene en memoria y se espeja a MySQL en cada mutación vía el repositorio.
Sobrevive reinicios del proceso porque `load_operational_snapshot()` recarga desde DB.
"""
from datetime import datetime, timezone

from app.repositories.mesa_state_repo import (
    load_operational_snapshot,
    persist_operational_state,
    release_operational_state,
)


class MesaOperationalState:
    """Estado operativo liviano de salón mientras corre el servidor."""

    def __init__(self):
        self.states: dict[int, dict] = {}

    def touch(self, id_mesa: int, **updates):
        state = self.states.setdefault(
            int(id_mesa),
            {
                "ocupada": True,
                "cuenta_solicitada": False,
                "mozo_solicitado": False,
                "last_activity_at": datetime.now(timezone.utc),
            },
        )
        state.update(updates)
        state["last_activity_at"] = datetime.now(timezone.utc)
        persist_operational_state(int(id_mesa), state)

    def release(self, id_mesa: int):
        self.states.pop(int(id_mesa), None)
        release_operational_state(int(id_mesa))

    def clear_service(self, id_mesa: int, service: str):
        state = self.states.get(int(id_mesa)) or load_operational_snapshot().get(
            int(id_mesa)
        )
        if not state:
            return
        if service == "mozo":
            state["mozo_solicitado"] = False
        elif service == "cuenta":
            state["cuenta_solicitada"] = False
        state["last_activity_at"] = datetime.now(timezone.utc)
        persist_operational_state(int(id_mesa), state)

    def snapshot(self) -> dict[int, dict]:
        persisted = load_operational_snapshot()
        persisted.update(self.states)
        return persisted.copy()


mesa_operational_state = MesaOperationalState()
