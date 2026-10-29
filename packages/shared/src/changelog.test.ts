import { describe, expect, it } from "vitest";
import {
  CHANGELOG,
  formatChangelogNotes,
  getChangelogEntry,
  normalizeChangelogVersion,
  resolveChangelogLocale,
} from "./changelog.js";
import { loadChangelogCatalog } from "./changelog-loader.js";

const STABLE_FROM = "0.1.0";

describe("changelog catalog", () => {
  it("keeps shipped locale version sets and highlight counts aligned", () => {
    const en = CHANGELOG.en;
    const zh = CHANGELOG["zh-CN"];
    for (const catalog of [
      zh,
      CHANGELOG["zh-TW"],
      CHANGELOG.tr,
      CHANGELOG.de,
      CHANGELOG.es,
      CHANGELOG.fr,
      CHANGELOG.ko,
      CHANGELOG["pt-BR"],
    ]) {
      expect(catalog.map((e) => e.version)).toEqual(en.map((e) => e.version));
      for (let i = 0; i < en.length; i += 1) {
        expect(catalog[i]?.highlights.length).toBe(en[i]?.highlights.length);
        expect(en[i]?.highlights.length).toBeGreaterThan(0);
      }
    }
  });

  it("lists stable releases from 0.1.0 newest-first without pre-releases", () => {
    const versions = CHANGELOG.en.map((e) => e.version);
    expect(versions[0]).toBe(STABLE_FROM);
    expect(versions.at(-1)).toBe(STABLE_FROM);
    // The in-app catalog restarts at 0.1.0 for this repository's own release
    // line. Earlier PI-Desktop history is not carried over.
    expect(versions).toEqual([STABLE_FROM]);
    for (const version of versions) {
      expect(version).not.toMatch(/-/);
    }
  });

  it("normalizes versions and resolves locales", () => {
    expect(normalizeChangelogVersion(" v0.2.7 ")).toBe("0.2.7");
    expect(resolveChangelogLocale("zh-CN")).toBe("zh-CN");
    expect(resolveChangelogLocale("zh-TW")).toBe("zh-TW");
    expect(resolveChangelogLocale("zh-Hant")).toBe("zh-TW");
    expect(resolveChangelogLocale("zh_HK")).toBe("zh-TW");
    expect(resolveChangelogLocale("tr-TR")).toBe("tr");
    expect(resolveChangelogLocale("de-DE")).toBe("de");
    expect(resolveChangelogLocale("es-MX")).toBe("es");
    expect(resolveChangelogLocale("fr-CA")).toBe("fr");
    expect(resolveChangelogLocale("ko-KR")).toBe("ko");
    expect(resolveChangelogLocale("ko_KR")).toBe("ko");
    expect(resolveChangelogLocale("pt")).toBe("pt-BR");
    expect(resolveChangelogLocale("pt-BR")).toBe("pt-BR");
    expect(resolveChangelogLocale("pt_BR")).toBe("pt-BR");
    expect(resolveChangelogLocale("en-US")).toBe("en");
    expect(resolveChangelogLocale()).toBe("en");
  });

  it("looks up and formats notes with English fallback", () => {
    const entry = getChangelogEntry("v0.1.0", "en");
    expect(entry?.version).toBe("0.1.0");
    const notes = formatChangelogNotes("0.1.0", "en");
    expect(notes).toMatch(/^• /);
    expect(notes?.split("\n").length).toBe(
      getChangelogEntry("0.1.0", "en")?.highlights.length,
    );
    expect(formatChangelogNotes("9.9.9", "en")).toBeUndefined();
    expect(formatChangelogNotes("0.2.0-rc.6", "en")).toBeUndefined();
  });

  it("loads and caches the catalog for the resolved locale", async () => {
    const catalog = await loadChangelogCatalog("fr-CA");

    expect(catalog).toBe(CHANGELOG.fr);
    expect(await loadChangelogCatalog("fr")).toBe(catalog);
  });
});
