import { HttpClient } from "@angular/common/http";
import { Injectable, signal } from "@angular/core";
import { TranslateService } from "@ngx-translate/core";
import { firstValueFrom } from "rxjs";

interface LanguageOption {
  code: string;
  nativeName: string;
}

const LANGUAGE_STORAGE_KEY = "nspanel-manager-language";
const LANGUAGE_CATALOG_URL = "/assets/i18n/languages.json";
const ENGLISH: LanguageOption = { code: "en", nativeName: "English" };

/** Loads the server language catalog and persists the selected UI language per browser. */
@Injectable({ providedIn: "root" })
export class LocaleService {
  readonly languages = signal<LanguageOption[]>([ENGLISH]);
  readonly currentLanguage = signal("en");

  constructor(
    private readonly http: HttpClient,
    private readonly translate: TranslateService
  ) {}

  /** Loads language metadata, registers translations, and restores the user's preference. */
  async initialize(): Promise<void> {
    let languages = [ENGLISH];
    try {
      const catalog = await firstValueFrom(this.http.get<unknown>(LANGUAGE_CATALOG_URL));
      languages = normalizeLanguageCatalog(catalog);
    } catch (error) {
      // The catalog is an optional extension point; the bundled English UI remains usable if it is unavailable.
      console.error("Could not load the UI language catalog; continuing with English.", error);
    }

    this.languages.set(languages);
    this.translate.addLangs(languages.map((language) => language.code));
    const language = getInitialLanguage(languages);
    try {
      await firstValueFrom(this.translate.use(language));
      this.currentLanguage.set(language);
      this.setDocumentLanguage(language);
    } catch (error) {
      console.error(`Could not load UI translations for '${language}'.`, error);
      if (language === ENGLISH.code) throw error;
      // Recover from a stale browser preference by loading the required English fallback.
      await firstValueFrom(this.translate.use(ENGLISH.code));
      this.currentLanguage.set(ENGLISH.code);
      this.setDocumentLanguage(ENGLISH.code);
    }
  }

  /** Loads and saves a language listed in the server's language catalog. */
  useLanguage(code: string): void {
    if (!this.languages().some((language) => language.code === code)) return;
    this.translate.use(code).subscribe({
      next: () => {
        this.currentLanguage.set(code);
        this.setDocumentLanguage(code);
        try {
          window.localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
        } catch (error) {
          console.warn("Could not save the UI language preference in this browser.", error);
        }
      },
      error: (error) => console.error(`Could not load UI translations for '${code}'.`, error)
    });
  }

  private setDocumentLanguage(code: string): void {
    if (typeof document !== "undefined") document.documentElement.lang = code;
  }
}

function normalizeLanguageCatalog(value: unknown): LanguageOption[] {
  if (!Array.isArray(value)) throw new Error("The UI language catalog must be an array.");
  const languages = value.flatMap((candidate): LanguageOption[] => {
    if (!isRecord(candidate)
      || typeof candidate.code !== "string"
      || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(candidate.code)
      || typeof candidate.nativeName !== "string"
      || !candidate.nativeName.trim()) return [];
    return [{ code: candidate.code, nativeName: candidate.nativeName.trim() }];
  });
  if (!languages.some((language) => language.code === ENGLISH.code)) {
    throw new Error("The UI language catalog must include English as the fallback language.");
  }
  return languages;
}

function getInitialLanguage(languages: LanguageOption[]): string {
  let preferred = "";
  try {
    preferred = window.localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? "";
  } catch (error) {
    console.warn("Could not read the saved UI language preference.", error);
  }
  if (languages.some((language) => language.code === preferred)) return preferred;
  const browserLanguage = typeof navigator === "undefined" ? "" : navigator.language;
  const matchingLanguage = languages.find((language) => language.code.toLowerCase() === browserLanguage.toLowerCase())
    ?? languages.find((language) => language.code.toLowerCase() === browserLanguage.split("-")[0]?.toLowerCase());
  return matchingLanguage?.code ?? ENGLISH.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
