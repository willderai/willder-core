/**
 * Why a Settings request failed, in words the panel can show: the server's own
 * `error` text when it sent one, otherwise the status it answered with. An error
 * page that is not JSON, or JSON without a text `error`, never surfaces as a parse
 * error.
 */
export async function failureReason(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : `the server answered ${res.status}`;
}
