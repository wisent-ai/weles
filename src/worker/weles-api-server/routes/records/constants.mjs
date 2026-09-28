// Bounds of the record routes, in one place.
//
// Account and setting names follow the item-id shapes Weles' Skarbiec records
// already enforce (src/state/skarbiec-records.ts); these limits only keep one
// request from carrying more than a record can hold.

export const MAX_PLATFORM_CHARS = 64;
export const MAX_USERNAME_CHARS = 256;
export const MAX_PASSWORD_CHARS = 1024;
export const MAX_DISPLAY_NAME_CHARS = 256;
export const MAX_SETTING_KEYS = 32;
export const ERROR_CHARS = 300;
export const HTTP_OK = 200;
export const HTTP_INVALID_REQUEST = 400;
export const HTTP_NOT_FOUND = 404;
export const HTTP_RECORD_FAILED = 502;
