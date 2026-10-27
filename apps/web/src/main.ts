import { bootstrapApplication } from "@angular/platform-browser";
import { provideHttpClient } from "@angular/common/http";
import { inject, provideAppInitializer } from "@angular/core";
import { provideTranslateService } from "@ngx-translate/core";
import { provideTranslateHttpLoader } from "@ngx-translate/http-loader";
import { AppComponent } from "./app.component";
import { LocaleService } from "./app/i18n/locale.service";

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    provideTranslateService({
      loader: provideTranslateHttpLoader({
        prefix: "/assets/i18n/",
        suffix: ".json",
        failOnError: true
      }),
      fallbackLang: "en",
      lang: "en"
    }),
    provideAppInitializer(() => inject(LocaleService).initialize())
  ]
}).catch((error) => console.error("Could not start the NSPanel Manager web app.", error));
