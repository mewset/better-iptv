/**
 * What a rejected command says, as one sentence for the user.
 *
 * A Tauri command rejects with the backend's `AppError` serialized as
 * `{ code, details }`, never with an `Error`, so `err.message` and `${err}`
 * both lose the sentence the backend wrote. Every place that shows a failed
 * command's reason goes through here.
 */
export function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const { code, details } = err as { code?: unknown; details?: unknown };
    if (typeof details === 'string' && details) return details;
    // The two variants whose details are a row id, not a sentence.
    if (code === 'PlaylistNotFound') return 'That profile no longer exists.';
    if (code === 'ChannelNotFound') return 'That channel is no longer in the playlist.';
  }
  return 'Something went wrong.';
}
