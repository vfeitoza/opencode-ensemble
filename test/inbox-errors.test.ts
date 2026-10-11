import { expect, test } from "bun:test"
import { decodeInboxError, isMissingSession, normalizeInboxResult } from "../src/inbox-errors"

test("only typed missing-session error is terminal, not arbitrary not found text", () => {
  expect(isMissingSession(decodeInboxError({ _tag: "SessionNotFoundError" }))).toBe(true)
  expect(isMissingSession(decodeInboxError({ status: 404, message: "not found" }))).toBe(false)
  expect(isMissingSession(decodeInboxError({ _tag: "UnauthorizedError" }))).toBe(false)
})

test("malformed response is not mistaken for a valid empty inbox", () => {
  expect(() => normalizeInboxResult({})).toThrow("Invalid inbox")
  expect(() => normalizeInboxResult({ data: [{ id: 3 }] })).toThrow("Invalid inbox")
  expect(normalizeInboxResult([])).toEqual({ data: [] })
  expect(normalizeInboxResult({ data: [] })).toEqual({ data: [] })
})
