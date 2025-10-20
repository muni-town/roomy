import { test, expect } from "@playwright/test";

test.describe("OPFS Diagnostics", () => {
  test("should report all OPFS and cross-origin isolation capabilities", async ({
    page,
  }) => {
    // Navigate to the app
    const response = await page.goto("/");
    const headers = response?.headers() || {};

    // Log headers
    console.log("=== HTTP Headers ===");
    console.log(
      "Cross-Origin-Embedder-Policy:",
      headers["cross-origin-embedder-policy"] || "NOT SET",
    );
    console.log(
      "Cross-Origin-Opener-Policy:",
      headers["cross-origin-opener-policy"] || "NOT SET",
    );

    // Check browser capabilities
    const diagnostics = await page.evaluate(async () => {
      const results: any = {
        headers: {
          coep: document.head
            .querySelector('meta[http-equiv="Cross-Origin-Embedder-Policy"]')
            ?.getAttribute("content"),
          coop: document.head
            .querySelector('meta[http-equiv="Cross-Origin-Opener-Policy"]')
            ?.getAttribute("content"),
        },
        crossOriginIsolated:
          typeof crossOriginIsolated !== "undefined"
            ? crossOriginIsolated
            : "undefined",
        sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
        atomics: typeof Atomics !== "undefined",
        opfs: {
          navigator_storage: typeof navigator.storage !== "undefined",
          getDirectory: typeof navigator.storage?.getDirectory === "function",
        },
        worker: {
          Worker: typeof Worker !== "undefined",
          SharedWorker: typeof SharedWorker !== "undefined",
        },
        userAgent: navigator.userAgent,
      };

      // Try to access OPFS
      if (results.opfs.getDirectory) {
        try {
          const root = await navigator.storage.getDirectory();
          results.opfs.accessSuccessful = true;
          results.opfs.rootHandle = !!root;
        } catch (e) {
          results.opfs.accessSuccessful = false;
          results.opfs.error = (e as Error).message;
        }
      }

      // Try to create SharedArrayBuffer
      if (results.sharedArrayBuffer) {
        try {
          new SharedArrayBuffer(1);
          results.sharedArrayBufferWorks = true;
        } catch (e) {
          results.sharedArrayBufferWorks = false;
          results.sharedArrayBufferError = (e as Error).message;
        }
      }

      return results;
    });

    // Log all diagnostics
    console.log("\n=== Browser Environment ===");
    console.log("User Agent:", diagnostics.userAgent);
    console.log("\n=== Cross-Origin Isolation ===");
    console.log("crossOriginIsolated:", diagnostics.crossOriginIsolated);
    console.log("SharedArrayBuffer available:", diagnostics.sharedArrayBuffer);
    console.log(
      "SharedArrayBuffer works:",
      diagnostics.sharedArrayBufferWorks || "N/A",
    );
    if (diagnostics.sharedArrayBufferError) {
      console.log("  Error:", diagnostics.sharedArrayBufferError);
    }
    console.log("Atomics available:", diagnostics.atomics);

    console.log("\n=== OPFS Support ===");
    console.log(
      "navigator.storage exists:",
      diagnostics.opfs.navigator_storage,
    );
    console.log("getDirectory() exists:", diagnostics.opfs.getDirectory);
    console.log(
      "OPFS access successful:",
      diagnostics.opfs.accessSuccessful || "N/A",
    );
    if (diagnostics.opfs.error) {
      console.log("  Error:", diagnostics.opfs.error);
    }

    console.log("\n=== Worker Support ===");
    console.log("Worker:", diagnostics.worker.Worker);
    console.log("SharedWorker:", diagnostics.worker.SharedWorker);

    // Now test in a Worker context
    console.log("\n=== Testing in Worker Context ===");
    const workerDiagnostics: any = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const worker = new Worker(
          URL.createObjectURL(
            new Blob(
              [
                `
          self.postMessage({
            crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'undefined',
            sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
            atomics: typeof Atomics !== 'undefined',
            opfsGetDirectory: typeof navigator.storage?.getDirectory === 'function',
          });
          
          // Try OPFS access
          if (typeof navigator.storage?.getDirectory === 'function') {
            navigator.storage.getDirectory()
              .then(root => {
                self.postMessage({ opfsAccessSuccessful: true, hasRoot: !!root });
              })
              .catch(e => {
                self.postMessage({ opfsAccessSuccessful: false, opfsError: e.message });
              });
          }
        `,
              ],
              { type: "application/javascript" },
            ),
          ),
          { type: "module" },
        );

        const results: any = {};
        let messageCount = 0;
        const expectedMessages = 2;

        worker.onmessage = (e) => {
          Object.assign(results, e.data);
          messageCount++;
          if (messageCount >= expectedMessages || results.opfsError) {
            worker.terminate();
            resolve(results);
          }
        };

        worker.onerror = (e) => {
          results.workerError = e.message;
          worker.terminate();
          resolve(results);
        };

        // Timeout after 2 seconds
        setTimeout(() => {
          if (messageCount < expectedMessages) {
            results.timeout = true;
            worker.terminate();
            resolve(results);
          }
        }, 2000);
      });
    });

    console.log(
      "Worker crossOriginIsolated:",
      workerDiagnostics.crossOriginIsolated,
    );
    console.log(
      "Worker SharedArrayBuffer:",
      workerDiagnostics.sharedArrayBuffer,
    );
    console.log("Worker Atomics:", workerDiagnostics.atomics);
    console.log(
      "Worker OPFS getDirectory:",
      workerDiagnostics.opfsGetDirectory,
    );
    console.log(
      "Worker OPFS access:",
      workerDiagnostics.opfsAccessSuccessful || "N/A",
    );
    if (workerDiagnostics.opfsError) {
      console.log("  Error:", workerDiagnostics.opfsError);
    }
    if (workerDiagnostics.workerError) {
      console.log("  Worker Error:", workerDiagnostics.workerError);
    }

    // Now test SQLite WASM VFS availability
    console.log("\n=== SQLite WASM VFS Availability ===");
    await page.waitForFunction(
      () => {
        return (window as any).backend;
      },
      { timeout: 15000 },
    );

    const sqliteDiagnostics: any = await page.evaluate(async () => {
      // Import sqlite3 in a worker
      return new Promise((resolve) => {
        const worker = new Worker(
          URL.createObjectURL(
            new Blob(
              [
                `
          import initSqlite3 from 'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.50.4-build1/sqlite-wasm/jswasm/sqlite3.mjs';
          
          (async () => {
            try {
              const sqlite3 = await initSqlite3({
                print: () => {},
                printErr: () => {}
              });
              
              const vfsInfo = {
                hasOpfsSAHPool: false,
                hasOpfs: false,
                sahPoolError: null,
                opfsError: null
              };
              
              // Check for OpfsSAHPoolVfs
              try {
                const pool = await sqlite3.installOpfsSAHPoolVfs({ initialCapacity: 1 });
                vfsInfo.hasOpfsSAHPool = !!pool;
              } catch (e) {
                vfsInfo.sahPoolError = e.message;
              }
              
              // Check for regular OPFS VFS
              const opfsVfs = sqlite3.capi.sqlite3_vfs_find('opfs');
              vfsInfo.hasOpfs = !!opfsVfs;
              if (!opfsVfs) {
                vfsInfo.opfsError = 'VFS not found';
              }
              
              self.postMessage({ success: true, vfsInfo });
            } catch (e) {
              self.postMessage({ success: false, error: e.message });
            }
          })();
        `,
              ],
              { type: "module" },
            ),
          ),
          { type: "module" },
        );

        worker.onmessage = (e) => {
          worker.terminate();
          resolve(e.data);
        };

        worker.onerror = (e) => {
          worker.terminate();
          resolve({ success: false, error: e.message });
        };

        setTimeout(() => {
          worker.terminate();
          resolve({ success: false, error: "timeout" });
        }, 10000);
      });
    });

    console.log(
      "SQLite initialization:",
      sqliteDiagnostics.success ? "SUCCESS" : "FAILED",
    );
    if (sqliteDiagnostics.error) {
      console.log("  Error:", sqliteDiagnostics.error);
    }
    if (sqliteDiagnostics.vfsInfo) {
      console.log(
        "  OpfsSAHPoolVfs available:",
        sqliteDiagnostics.vfsInfo.hasOpfsSAHPool,
      );
      if (sqliteDiagnostics.vfsInfo.sahPoolError) {
        console.log("    Error:", sqliteDiagnostics.vfsInfo.sahPoolError);
      }
      console.log(
        "  Regular OPFS VFS available:",
        sqliteDiagnostics.vfsInfo.hasOpfs,
      );
      if (sqliteDiagnostics.vfsInfo.opfsError) {
        console.log("    Error:", sqliteDiagnostics.vfsInfo.opfsError);
      }
    }

    // Summary and recommendations
    console.log("\n=== SUMMARY ===");
    const issues = [];
    const recommendations = [];

    if (
      diagnostics.crossOriginIsolated === false ||
      diagnostics.crossOriginIsolated === "undefined"
    ) {
      issues.push("❌ Cross-origin isolation NOT active");
      recommendations.push(
        "Check that COOP/COEP headers are being sent by the dev server",
      );
    } else {
      console.log("✅ Cross-origin isolation is active");
    }

    if (!diagnostics.sharedArrayBuffer) {
      issues.push("❌ SharedArrayBuffer NOT available");
      recommendations.push(
        "SharedArrayBuffer requires cross-origin isolation (COOP/COEP headers)",
      );
    } else {
      console.log("✅ SharedArrayBuffer is available");
    }

    if (!diagnostics.opfs.getDirectory) {
      issues.push("❌ OPFS API NOT available");
      recommendations.push(
        "This browser/environment does not support OPFS - consider using a different storage backend",
      );
    } else if (diagnostics.opfs.accessSuccessful === false) {
      issues.push("❌ OPFS API exists but access FAILED");
      recommendations.push(
        "OPFS may require secure context or have browser-specific limitations",
      );
    } else {
      console.log("✅ OPFS API is available and accessible");
    }

    if (!workerDiagnostics.opfsGetDirectory) {
      issues.push("❌ OPFS NOT available in Worker context");
      recommendations.push("OPFS VFS requires Worker support for OPFS APIs");
    } else {
      console.log("✅ OPFS is available in Worker context");
    }

    if (issues.length > 0) {
      console.log("\n=== ISSUES FOUND ===");
      issues.forEach((issue) => console.log(issue));
      console.log("\n=== RECOMMENDATIONS ===");
      recommendations.forEach((rec) => console.log("→", rec));
    }

    // Assertions for CI
    expect(diagnostics.worker.Worker).toBe(true);
    // Note: We don't fail the test if OPFS isn't available, just report it
  });
});
