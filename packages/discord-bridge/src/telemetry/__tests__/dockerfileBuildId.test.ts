/**
 * The bridge image must declare its build identity in the stage that RUNS the
 * bridge — not in the `builder` stage. Docker does not propagate `ARG`/`ENV`
 * across `FROM` boundaries, so a `BUILD_ID` declared only in a build stage
 * leaves the runtime process with nothing, and every log line carries
 * `build_id: "unknown"` (`src/logger.ts` reads `BUILD_ID`).
 *
 * The failure is invisible to a unit test of `resolveBuildId` — the rule works
 * fine there, it just receives no value — and invisible in CI, which builds no
 * image. Parsing the Dockerfile is the cheap guard that fails on the broken
 * layout.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(
	new URL("../../../Dockerfile", import.meta.url),
	"utf8",
);

/** Split the Dockerfile into stages at each `FROM`. */
function stages(source: string): { header: string; body: string[] }[] {
	const out: { header: string; body: string[] }[] = [];
	for (const line of source.split("\n")) {
		if (/^\s*FROM\s/i.test(line)) out.push({ header: line.trim(), body: [] });
		else if (out.length > 0) out[out.length - 1]!.body.push(line);
	}
	return out;
}

/** The stage the image actually runs from: the one carrying the ENTRYPOINT
 *  that starts the bridge. */
function runtimeStage(source: string) {
	const runtime = stages(source).find((s) =>
		s.body.some((l) => /^\s*ENTRYPOINT\s/i.test(l)),
	);
	expect(runtime).toBeDefined();
	return runtime!;
}

describe("discord-bridge Dockerfile build identity", () => {
	test("the runtime stage declares the commit ARG", () => {
		expect(runtimeStage(dockerfile).body.join("\n")).toMatch(
			/^\s*ARG\s+RAILWAY_GIT_COMMIT_SHA\s*$/m,
		);
	});

	test("the runtime stage derives BUILD_ID from it, first 8 chars", () => {
		// The expansion mirrors Dockerfile.appserver's exactly, so the three
		// services' build_id values have the same shape in one log query.
		expect(runtimeStage(dockerfile).body.join("\n")).toContain(
			'ENV BUILD_ID=${RAILWAY_GIT_COMMIT_SHA%"${RAILWAY_GIT_COMMIT_SHA#??*??????}"}',
		);
	});

	test("the ARG precedes and feeds the ENV (kept as a cache-buster)", () => {
		// Referencing the ARG in the stage puts its value in that layer's cache
		// key; a new commit then rebuilds rather than reusing a runtime image
		// built from a different one.
		const body = runtimeStage(dockerfile).body;
		const argAt = body.findIndex((l) => /^\s*ARG\s+RAILWAY_GIT_COMMIT_SHA/.test(l));
		const envAt = body.findIndex((l) => /^ENV BUILD_ID=/.test(l));
		expect(argAt).toBeGreaterThanOrEqual(0);
		expect(envAt).toBeGreaterThan(argAt);
	});

	test("the identity is not confined to a builder stage", () => {
		// The appserver bug: a pair declared before the last FROM is invisible
		// to the process that runs, so the image reports "unknown" even when
		// the build supplied a sha. If any builder stage mentions it, the
		// runtime stage above must declare it too.
		const all = stages(dockerfile);
		const inBuilder = all
			.slice(0, -1)
			.some((s) => /RAILWAY_GIT_COMMIT_SHA/.test(s.body.join("\n")));
		if (inBuilder) {
			expect(runtimeStage(dockerfile).body.join("\n")).toMatch(
				/RAILWAY_GIT_COMMIT_SHA/,
			);
		}
	});
});
