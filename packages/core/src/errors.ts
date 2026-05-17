import { describe, expect, it } from "vitest";
import { ZerithValidationError } from "../internal/errors.js";

describe("ZerithValidationError", () => {
  it("should create validation error correctly", () => {
    const error = new ZerithValidationError("Validation failed");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ZerithValidationError");
    expect(error.message).toBe("Validation failed");
  });

  it("should store zod error payload", () => {
    const mockError = { field: "email" };

    const error = new ZerithValidationError(
      "Invalid input",
      mockError
    );

    expect(error.zodError).toEqual(mockError);
  });
});