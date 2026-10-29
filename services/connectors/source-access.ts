// The error a connector throws when its credential can no longer read the
// source at all: the repository, folder or insight answers "not found" or
// "forbidden" to this credential.
//
// The one rule: losing access is never evidence that anything was deleted.
// GitHub answers 404 to a token that cannot see a private repository, and
// Google Drive lists nothing in a folder the account can no longer open, so
// "deleted" and "no access" can look the same. A sync that meets this error
// keeps everything the source stored, marks the source as having lost access
// (lib/inngest/connector-sync.ts) and stops; only a connector's explicit sign
// that the source is gone may retire what it stored.

/** The message is written for the person who connected the source, names the fix, and never carries the credential. */
export class SourceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceAccessError";
  }
}
