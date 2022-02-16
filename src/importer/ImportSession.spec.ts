import { mock, restore } from 'simple-mock'

import { Flatfile } from '../Flatfile'
import { IteratorCallback } from '../lib/RecordChunkIterator'
import { createChunk, makeRecords } from '../lib/test-helper'
import { RecordsChunk } from '../service/RecordsChunk'
import { ImportFrame } from './ImportFrame'
import { ImportSession } from './ImportSession'

jest.mock('../graphql/ApiService')

describe('ImportSession', () => {
  let flatfile: Flatfile
  let session: ImportSession
  let chunk: RecordsChunk
  let callbackFn: IteratorCallback
  beforeEach(async () => {
    flatfile = new Flatfile('asdf', { apiUrl: 'http://localhost:3000' })
    session = new ImportSession(flatfile, {
      batchId: 'abc',
      workspaceId: 'def',
      workbookId: 'hij',
      schemaIds: ['99'],
    })

    chunk = createChunk(session, makeRecords(0, 10), 10, 0, 10)
    callbackFn = jest.fn((chunk, next) => {
      next()
    })
    mock(session.flatfile.api, 'getRecordsByStatus').returnWith(chunk)
  })

  afterEach(() => {
    restore()
  })

  test('openInEmbeddedIframe', async () => {
    expect(document.body.classList).not.toContain('flatfile-active')
    await session.openInEmbeddedIframe()
    expect(document.body.classList).toContain('flatfile-active')
  })

  describe('iframe', () => {
    test('is created on demand', async () => {
      expect(session.iframe).toBeInstanceOf(ImportFrame)
    })

    test('is re-used on 2nd invocation', async () => {
      const firstFrame = session.iframe
      expect(firstFrame).toBeInstanceOf(ImportFrame)
      expect(session.iframe).toBe(firstFrame)
    })
  })

  test('signedImportUrl', async () => {
    expect(session.signedImportUrl()).toContain('batchId=abc')
    expect(session.signedImportUrl()).toContain('jwt=asdf')
  })

  test('processPendingRecords', async () => {
    await expect(session.processPendingRecords(callbackFn)).resolves.toBe(undefined)
  })

  describe('updateEnvironment', () => {
    test('calls api with payload', async () => {
      const spy = jest.spyOn(session.flatfile.api, 'updateSessionEnv')
      await session.updateEnvironment({ foo: 'bar' })
      expect(spy).toHaveBeenCalledWith(session, { foo: 'bar' })
    })
  })

  describe('openInNewWindow', () => {
    test('triggers window.open', () => {
      const openFn = mock(window, 'open').returnWith(true)
      session.openInNewWindow()
      expect(openFn.called).toBe(true)
    })

    test('throws error if window fails to open', () => {
      mock(window, 'open').returnWith(null)
      expect(() => session.openInNewWindow()).toThrow(Error)
    })

    test('emits launch event', () => {
      mock(window, 'open').returnWith(true)
      const spy = jest.spyOn(session, 'emit')
      session.openInNewWindow()
      expect(spy).toHaveBeenCalledWith('launch', { batchId: session.batchId })
    })
  })
})
