import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	dependencies: versionizeDeps(
		[
			"@marianmeres/clog",
			"@marianmeres/cron-parser",
			"@marianmeres/modelize",
			"@marianmeres/parse-boolean",
			"@marianmeres/pubsub",
			"pg",
			"@types/pg",
		],
		denoJson,
	),
	// `registry.validate()` adapts JSON Schema through the
	// "@marianmeres/modelize/ajv" subpath, which needs AJV. Mirrors modelize's own
	// declaration, range included: everyone who doesn't use `paramsSchema` never
	// installs it. Note that npm does not auto-install optional peers — this
	// declares the requirement, the README tells users to act on it.
	peerDependencies: ["ajv@^8.20.0"],
	peerDependenciesMeta: { ajv: { optional: true } },
});
