import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setPlatform } from "../platform";
import { memoryPlatform } from "./platform";

// テストごとに空のメモリ上の Platform にする
setPlatform(memoryPlatform());
beforeEach(() => setPlatform(memoryPlatform()));
afterEach(() => cleanup());
