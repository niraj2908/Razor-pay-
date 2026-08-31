/**
 * `@types/pdfmake` covers the top-level `pdfmake` module but not its
 * `standard-fonts/*` submodules (plain font-descriptor objects pointing at
 * PDFKit's built-in standard font names - see `lib/reports/pdfReport.ts`'s
 * own doc comment for why these are used instead of an embedded TTF).
 */
declare module "pdfmake/standard-fonts/Helvetica.js" {
  const fonts: { Helvetica: { normal: string; bold: string; italics: string; bolditalics: string } };
  export default fonts;
}
