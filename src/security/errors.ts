/** Base class for everything the security layer refuses to do. */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/** The acting user is not permitted to perform the action. */
export class AccessDeniedError extends SecurityError {
  constructor(message: string) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

/**
 * The target does not exist -- or the user may not see that it exists.
 * The security layer deliberately reports both cases identically so that
 * probing for ids cannot be used to enumerate records.
 */
export class NotFoundError extends SecurityError {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** The request was well-formed but the data it carried was not valid. */
export class ValidationError extends SecurityError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
