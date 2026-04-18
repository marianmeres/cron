import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	dependencies: versionizeDeps(
		[
			"@marianmeres/clog",
			"@marianmeres/modelize",
			"@marianmeres/parse-boolean",
			"@marianmeres/pubsub",
			"pg",
			"@types/pg",
		],
		"../deno.json",
	),
});
