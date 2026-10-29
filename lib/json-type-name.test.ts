// bodyTypeRefusal's field paths: a plain string field, a string nested in an object, an
// array of strings and an object. Each refusal names the deepest part of the path that
// had the wrong type, so a caller can find it in the body it sent.
import { describe, expect, it } from "vitest";
import { bodyTypeRefusal } from "./json-type-name";

describe("bodyTypeRefusal", () => {
  it("refuses a body that is not a JSON object before reading any field", () => {
    expect(bodyTypeRefusal([{ name: "x" }], ["name"])).toBe("request body must be a JSON object, not an array");
    expect(bodyTypeRefusal(null, ["name"])).toBe("request body must be a JSON object, not null");
  });

  it("names a string field sent as another type", () => {
    expect(bodyTypeRefusal({ name: 0 }, ["name"])).toBe("name must be a string, not a number");
  });

  it("names the parent of a nested field when the parent is not an object", () => {
    expect(bodyTypeRefusal({ target: "https://x.test" }, ["target.baseUrl"])).toBe(
      "target must be an object, not a string",
    );
    expect(bodyTypeRefusal({ target: ["https://x.test"] }, ["target.baseUrl"])).toBe(
      "target must be an object, not an array",
    );
  });

  it("names the nested field itself when it has the wrong type", () => {
    expect(bodyTypeRefusal({ target: { baseUrl: 7 } }, ["target.baseUrl"])).toBe(
      "target.baseUrl must be a string, not a number",
    );
  });

  it("names a list that is not an array, and the index of the first element that is not a string", () => {
    expect(bodyTypeRefusal({ aliases: "ceo" }, ["aliases[]"])).toBe("aliases must be an array, not a string");
    expect(bodyTypeRefusal({ aliases: ["ceo", "boss", null] }, ["aliases[]"])).toBe(
      "aliases[2] must be a string, not null",
    );
    expect(bodyTypeRefusal({ target: { allowedHosts: [{}] } }, ["target.allowedHosts[]"])).toBe(
      "target.allowedHosts[0] must be a string, not an object",
    );
  });

  it("names an object field sent as another type, without checking what is inside it", () => {
    expect(bodyTypeRefusal({ socialLinks: [] }, ["socialLinks{}"])).toBe("socialLinks must be an object, not an array");
    expect(bodyTypeRefusal({ socialLinks: { followers: 3 } }, ["socialLinks{}"])).toBeUndefined();
  });

  it("reads a null or absent field, or a null parent, as missing rather than refusing it", () => {
    const fields = ["name", "target.baseUrl", "aliases[]", "socialLinks{}"];
    expect(bodyTypeRefusal({}, fields)).toBeUndefined();
    expect(bodyTypeRefusal({ name: null, target: null, aliases: null, socialLinks: null }, fields)).toBeUndefined();
    expect(bodyTypeRefusal({ target: { baseUrl: null } }, fields)).toBeUndefined();
  });

  it("accepts every field when each has its declared type", () => {
    const body = { name: "n", target: { baseUrl: "https://x.test" }, aliases: [], socialLinks: {} };
    expect(bodyTypeRefusal(body, ["name", "target.baseUrl", "aliases[]", "socialLinks{}"])).toBeUndefined();
  });
});
