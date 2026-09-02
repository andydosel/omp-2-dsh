/** Base class for every error thrown by the tree engine. */
export class TreeEngineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Thrown when an operation references a node id that does not exist. */
export class UnknownNodeError extends TreeEngineError {
  constructor(nodeId: string) {
    super(`Unknown node id: ${nodeId}`);
  }
}

/** Thrown when appending a node whose id already exists. */
export class DuplicateNodeError extends TreeEngineError {
  constructor(nodeId: string) {
    super(`Duplicate node id: ${nodeId}`);
  }
}

/** Thrown when a serialized tree is malformed (invalid JSON or bad shape). */
export class InvalidTreeError extends TreeEngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
