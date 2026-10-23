# Local ESPHome Nextion component override

This directory vendors the ESPHome 2026.7.0 `nextion` component so the unified
ESP-IDF firmware can attach the ESP-IDF certificate bundle to the component's
own HTTP client when downloading TFT files over HTTPS. The stock
`http_request` component already does this; the Nextion TFT uploader has a
separate client and otherwise fails before the transfer starts.

The source files are copied from the installed ESPHome component and retain
their upstream license headers. When updating ESPHome, compare this directory
with the new upstream `esphome/components/nextion` and carry the certificate
bundle attachment into `nextion_upload_esp32.cpp`.
