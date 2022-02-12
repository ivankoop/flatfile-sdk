import { ClientError, GraphQLClient } from 'graphql-request'
import { SubscriptionClient } from 'graphql-subscriptions-client'

import { RequestError } from '../errors/RequestError'
import { UnauthorizedError } from '../errors/UnauthorizedError'
import { IImportMeta, ImportSession } from '../importer/ImportSession'
import { ERecordStatus, FlatfileRecord, TPrimitive } from '../service/FlatfileRecord'
import { RecordsChunk } from '../service/RecordsChunk'
import {
  INITIALIZE_EMPTY_BATCH,
  InitializeEmptyBatchPayload,
  InitializeEmptyBatchResponse,
} from './mutations/INITIALIZE_EMPTY_BATCH'
import { UPDATE_WORKSPACE_ENV } from './mutations/UPDATE_WORKSPACE_ENV'
import {
  GET_FINAL_DATABASE_VIEW,
  GetFinalDatabaseViewPayload,
  GetFinalDatabaseViewResponse,
} from './queries/GET_FINAL_DATABASE_VIEW'
import { PREFLIGHT_BATCH } from './queries/PREFLIGHT_BATCH'
import { UPDATE_RECORD_STATUS } from './queries/UPDATE_RECORDS_STATUS'
import {
  BATCH_STATUS_UPDATED,
  BatchStatusUpdatedResponse,
} from './subscriptions/BATCH_STATUS_UPDATED'

const DEFAULT_PAGE_LIMIT = process.env.DEFAULT_PAGE_LIMIT
  ? parseInt(process.env.DEFAULT_PAGE_LIMIT, 10)
  : 1000

export class ApiService {
  public client: GraphQLClient
  public pubsub: SubscriptionClient

  constructor(public token: string, public apiUrl: string) {
    this.client = new GraphQLClient(`${apiUrl}/graphql`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    })
    this.pubsub = new SubscriptionClient(`${apiUrl.replace(/^http/, 'ws')}/graphql`, {
      reconnect: true,
      lazy: true,
      connectionParams: {
        isWebSocket: true,
        headers: {
          authorization: `Bearer ${this.token}`,
        },
      },
    })
  }

  /**
   * Initialize a new batch or obtain the current batch
   *
   * @private
   */
  public async initEmptyBatch(): Promise<InitializeEmptyBatchResponse['initializeEmptyBatch']> {
    const req = this.client.request<InitializeEmptyBatchResponse, InitializeEmptyBatchPayload>(
      INITIALIZE_EMPTY_BATCH,
      {
        importedFromUrl: location.href,
      }
    )
    return this.handleResponse('initializeEmptyBatch', req)
  }

  /**
   * Initialize an empty batch or obtain the current one, returns normalized
   * payload.
   */
  async init(): Promise<IImportMeta> {
    const { batchId, workspaceId, schemas } = await this.initEmptyBatch()
    const schemaIds = schemas.map((s) => s.id)
    return { batchId, workspaceId, schemaIds }
  }

  /**
   * Get the current main workbook id for any batch
   *
   * @param batchId
   * @private
   */
  public async getWorkbookId(batchId: string): Promise<string> {
    const req = this.client.request(PREFLIGHT_BATCH, { batchId })
    const res = await this.handleResponse('preflightBatch', req)
    return res.workbookId
  }

  /**
   * @deprecated this should not be used ever
   * @param batchId
   * @param skip
   * @param sample
   * @param limit
   */
  async getAllRecords(
    batchId: string,
    skip = 0,
    sample = false,
    limit = DEFAULT_PAGE_LIMIT
  ): Promise<GetFinalDatabaseViewResponse['getFinalDatabaseView']> {
    const req = this.client.request<GetFinalDatabaseViewResponse, GetFinalDatabaseViewPayload>(
      GET_FINAL_DATABASE_VIEW,
      {
        batchId,
        skip,
        limit: DEFAULT_PAGE_LIMIT,
      }
    )
    const { rows, totalRows } = await this.handleResponse('getFinalDatabaseView', req)

    if (!sample && skip + limit < totalRows) {
      const { rows: nextRows } = await this.getAllRecords(batchId, skip + limit)
      return {
        rows: rows.concat(nextRows),
        totalRows,
      }
    }

    return {
      rows,
      totalRows,
    }
  }

  /**
   * Return a list of FlatfileRecords based on status
   *
   * @todo clean up validation status vs stage and support both
   *
   * @param session
   * @param status
   * @param skip
   * @param limit
   */
  async getRecordsByStatus(
    session: ImportSession,
    status: ERecordStatus,
    skip = 0,
    limit = DEFAULT_PAGE_LIMIT
  ): Promise<RecordsChunk> {
    const req = this.client.request<GetFinalDatabaseViewResponse, GetFinalDatabaseViewPayload>(
      GET_FINAL_DATABASE_VIEW,
      {
        status,
        batchId: session.batchId,
        skip,
        limit,
      }
    )

    const res = await this.handleResponse('getFinalDatabaseView', req)

    return new RecordsChunk(
      session,
      res.rows.map((r) => new FlatfileRecord(r)),
      {
        status,
        skip: skip,
        limit: limit,
        totalRecords: res.totalRows,
      }
    )
  }

  /**
   * Bulk update record statuses by ids
   *
   * @param session
   * @param recordIds
   * @param status
   */
  public updateRecordStatus(
    session: ImportSession,
    recordIds: number[],
    status: ERecordStatus
  ): Promise<{ id: string }> {
    const req = this.client.request(UPDATE_RECORD_STATUS, {
      workbookId: session.meta.workbookId,
      schemaId: parseInt(session.meta.schemaIds[0], 10),
      validationState: status,
      rowIds: recordIds,
    })
    return this.handleResponse('queueUpdateRecordStatus', req)
  }

  /**
   * Update the value of one or more session environment keys
   *
   * @param session
   * @param env
   */
  public updateSesssionEnv(
    session: ImportSession,
    env: Record<string, TPrimitive>
  ): Promise<{ success: boolean }> {
    const req = this.client.request(UPDATE_WORKSPACE_ENV, {
      workspaceId: session.meta.workspaceId,
      env,
    })
    return this.handleResponse('updateWorkspaceEnvironment', req)
  }

  /**
   * Start a websocket subscription for a specific batchID
   *
   * @param batchId
   * @param observe
   */
  /* istanbul ignore next */
  public subscribeBatchStatusUpdated(
    batchId: string,
    observe: (d: BatchStatusUpdatedResponse) => void
  ): void {
    const query = BATCH_STATUS_UPDATED
    this.pubsub.request({ query, variables: { batchId } }).subscribe({
      next: ({ data, errors }: IBatchStatusSubscription) => {
        if (errors) {
          return this.handleError(errors)
        }
        observe(data)
      },
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public handleError(errors?: ClientError['response']['errors'], message?: string): any {
    if (errors?.length) {
      errors.forEach((e) => {
        if (e.message === 'Unauthorized') {
          throw new UnauthorizedError()
        }

        throw new RequestError(`Internal Server Error: "${e.message}"`)
      })
    }
    throw new RequestError(`${message || 'Something went wrong'}`)
  }

  public async handleResponse<T, K extends keyof T>(
    queryName: K,
    query: Promise<T>
  ): Promise<T[K]> {
    try {
      const res = await query
      return res[queryName]
    } catch (error) {
      const err: ClientError = error as ClientError
      return this.handleError(err.response.errors, err.message)
    }
  }
}

interface IBatchStatusSubscription {
  data: BatchStatusUpdatedResponse
  errors: ClientError['response']['errors']
}
