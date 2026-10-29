// Setup file for github.real-scale.load.test.ts: makes every provider response body take 40 ms to
// read, standing in for a loaded machine where each await of the connector's fetch-and-parse loop
// waits its turn. Deterministic: the delay does not depend on the machine's real load.
const DELAY_MS = 40;
const realJson = Response.prototype.json;

Response.prototype.json = async function slowJson(this: Response) {
  await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  return realJson.call(this);
};
