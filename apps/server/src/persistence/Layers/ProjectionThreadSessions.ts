import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionThreadSession,
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
  DeleteProjectionThreadSessionInput,
  GetProjectionThreadSessionInput,
} from "../Services/ProjectionThreadSessions.ts";

const ProjectionThreadSessionDbRow = ProjectionThreadSession.mapFields(
  Struct.assign({
    actionState: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(ProjectionThreadSession.fields.actionState)),
    ),
    commandCatalog: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(ProjectionThreadSession.fields.commandCatalog)),
    ),
    noticeBoard: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(ProjectionThreadSession.fields.noticeBoard)),
    ),
    contextState: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(ProjectionThreadSession.fields.contextState)),
    ),
    runtimeCapabilities: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(ProjectionThreadSession.fields.runtimeCapabilities)),
    ),
  }),
);

const makeProjectionThreadSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSessionRow = SqlSchema.void({
    Request: ProjectionThreadSession,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at,
          action_state_json,
          command_catalog_json,
          notice_board_json,
          context_state_json,
          runtime_capabilities_json
        )
        VALUES (
          ${row.threadId},
          ${row.status},
          ${row.providerName},
          ${row.providerInstanceId},
          ${row.runtimeMode},
          ${row.activeTurnId},
          ${row.lastError},
          ${row.updatedAt},
          ${row.actionState === undefined ? null : JSON.stringify(row.actionState)},
          ${row.commandCatalog === undefined ? null : JSON.stringify(row.commandCatalog)},
          ${row.noticeBoard === undefined ? null : JSON.stringify(row.noticeBoard)},
          ${row.contextState === undefined ? null : JSON.stringify(row.contextState)},
          ${row.runtimeCapabilities === undefined ? null : JSON.stringify(row.runtimeCapabilities)}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          runtime_mode = excluded.runtime_mode,
          active_turn_id = excluded.active_turn_id,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at,
          action_state_json = excluded.action_state_json,
          command_catalog_json = excluded.command_catalog_json,
          notice_board_json = excluded.notice_board_json,
          context_state_json = excluded.context_state_json,
          runtime_capabilities_json = excluded.runtime_capabilities_json
      `,
  });

  const getProjectionThreadSessionRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadSessionInput,
    Result: ProjectionThreadSessionDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt",
          action_state_json AS "actionState",
          command_catalog_json AS "commandCatalog",
          notice_board_json AS "noticeBoard",
          context_state_json AS "contextState",
          runtime_capabilities_json AS "runtimeCapabilities"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadSessionRow = SqlSchema.void({
    Request: DeleteProjectionThreadSessionInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadSessionRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadSessionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSessionRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadSessionRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadSessionRow(input).pipe(
      // SQL NULL decodes to null; the repository contract models absence as
      // an omitted optional field.
      Effect.map(
        Option.map(
          ({
            actionState,
            commandCatalog,
            noticeBoard,
            contextState,
            runtimeCapabilities,
            ...rest
          }) => ({
            ...rest,
            ...(actionState != null ? { actionState } : {}),
            ...(commandCatalog != null ? { commandCatalog } : {}),
            ...(noticeBoard != null ? { noticeBoard } : {}),
            ...(contextState != null ? { contextState } : {}),
            ...(runtimeCapabilities != null ? { runtimeCapabilities } : {}),
          }),
        ),
      ),
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.getByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadSessionRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadSessionRepositoryShape;
});

export const ProjectionThreadSessionRepositoryLive = Layer.effect(
  ProjectionThreadSessionRepository,
  makeProjectionThreadSessionRepository,
);
