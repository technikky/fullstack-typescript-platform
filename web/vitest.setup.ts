import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Unmount between tests, explicitly.
 *
 * Testing Library auto-registers this only when a global `afterEach` exists. This project runs
 * vitest without globals, so without these three lines every test renders on top of the previous
 * one's DOM -- and `getByRole` then fails with "found multiple elements" in tests that pass
 * perfectly well on their own. That is a confusing failure to debug, so it is wired up here once.
 */
afterEach(() => {
  cleanup();
});
