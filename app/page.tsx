import { redirect } from "next/navigation";

// The hosted site's landing page is not part of this repository: / opens the app.
export default function Home(): never {
  redirect("/dashboard");
}
