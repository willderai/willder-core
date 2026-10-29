// Random base64 that holds a `/` must still be removed by layer 6.
//
// Layer 6 treats a run with a `/` in it as a path when half of its segments longer than
// 3 characters are mostly lower case, and then removes only segments of 32+ characters. A
// random base64 secret has `/` in it about 3 times in 5 at 40 characters (an AWS secret
// access key, `openssl rand -base64 30`), and its short segments come out mostly lower case
// often enough that a sampled 6-15% of them would pass whole. The cases below are drawn from
// those samples and stand alone, as a value an
// agent quotes without a secret-named key in front of it ("Set the secret to ... in Vercel").
import { describe, expect, it } from "vitest";
import { redact } from "./willder-redact.mjs";

const SAMPLES = [
  // 40 characters, the AWS secret access key shape
  "hqd84yjlWqH3ecB/fLfUfrGvonjYdCxD6Twc3C2x",
  "0rvppdq2YaXbBYm9861cY6V/zfgcgHqfjkiBgXj3",
  "AZLNGpORuL3ilCspNX+HmmOpDepl/lmZ/gthLlZh",
  "movalUeuXjO4z/KgxhNgrgcF1378NAt4dlrj50Ki",
  // 44 characters, `openssl rand -base64 32`
  "R2v5cAVgBEy83oMlWgspDc+8hcSss/ra0QyyC+rvmL==",
  "tdZlOluLIr5j+SrP99ufvb+lJ/+r2loIrp4+7T9jlX==",
  "C13/rRgbi2N67j+/FqNPxKR6qQG6OwZylchxvQjVYA==",
  "L34Jc6+Pvg04Nrdxn3z0iiVjC2Y/rr8D1+Zcag7rhp==",
  // 32 characters, `openssl rand -base64 24`
  "TLeBNQnnLytUb15MvOWdI/6kvT7fsywg",
  "wBE77WmD6AOK3/ulc0o48d8wmppBTgTt",
  "P8d/wCZzfaqaga4+h4wmvtLrF/UwGUOE",
  "kzxByKlBRrddzGblj5wq/0mGCtvPXpZ2",
];

describe("redact: random base64 with a slash in it is not a path", () => {
  it.each(SAMPLES)("removes %s", (secret) => {
    expect(redact(`Set the secret to ${secret} in Vercel.`, {})).not.toContain(secret);
  });

  it("still keeps the paths the path rule was written for", () => {
    for (const path of [
      "public/images/hero-4f3a2b1c9d8e7f60.png",
      "vendor/github.com/aws/aws-sdk-go-v2/service/s3/api_op_PutObject.go",
    ]) {
      expect(redact(`edited ${path}`, {})).toBe(`edited ${path}`);
    }
  });
});
