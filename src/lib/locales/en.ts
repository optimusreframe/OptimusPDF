import type { ToolCategory, ToolSlug } from "@/lib/tools-registry";
import type { Dictionary, ToolCopy } from "@/lib/locales/es";

const tools: Record<ToolSlug, ToolCopy> = {
  "merge-pdf": {
    name: "Merge PDF",
    description:
      "Combine several PDFs into one document and decide the exact order of every file.",
  },
  "split-pdf": {
    name: "Split PDF",
    description:
      "Break a document by ranges, every N pages, or pull single sections out into a ZIP.",
  },
  "remove-pages": {
    name: "Remove pages",
    description:
      "Drop the pages you do not need by marking them on the document thumbnails.",
  },
  "extract-pages": {
    name: "Extract pages",
    description: "Build a new PDF with only the pages you pick from the original.",
  },
  "organize-pdf": {
    name: "Organise PDF",
    description: "Reorder, rotate and delete pages from a single thumbnail view.",
  },
  "rotate-pdf": {
    name: "Rotate PDF",
    description:
      "Turn single pages or the whole document in multiples of 90 degrees.",
  },
  "pdfs-to-zip": {
    name: "PDFs to ZIP",
    description:
      "Package several PDFs into a single ZIP file without merging or reprocessing their content.",
  },
  "compress-pdf": {
    name: "Compress PDF",
    description:
      "Cut file weight by re-encoding images and cleaning objects, without wrecking readability.",
  },
  "repair-pdf": {
    name: "Repair PDF",
    description: "Recover damaged documents by rebuilding their internal structure.",
  },
  "ocr-pdf": {
    name: "OCR PDF",
    description:
      "Recognise the text inside scanned documents so you can search and copy it.",
  },
  "jpg-to-pdf": {
    name: "Image to PDF",
    description:
      "Turn JPG, PNG or WEBP into a PDF, choosing page size, margin and orientation.",
  },
  "word-to-pdf": {
    name: "Word to PDF",
    description: "Take DOC and DOCX documents to PDF keeping the original layout.",
  },
  "powerpoint-to-pdf": {
    name: "PowerPoint to PDF",
    description: "Convert PPT and PPTX decks into a PDF ready to send.",
  },
  "excel-to-pdf": {
    name: "Excel to PDF",
    description: "Convert XLS and XLSX spreadsheets into a paginated PDF.",
  },
  "html-to-pdf": {
    name: "HTML to PDF",
    description: "Capture a web page or an HTML file as a PDF document.",
  },
  "scan-to-pdf": {
    name: "Scan to PDF",
    description:
      "Use your phone camera as a scanner and store the captures in a PDF.",
  },
  "pdf-to-jpg": {
    name: "PDF to JPG",
    description: "Turn every page into a JPG image and download them all in a ZIP.",
  },
  "pdf-to-word": {
    name: "PDF to Word",
    description: "Convert the PDF into an editable DOCX document.",
  },
  "pdf-to-powerpoint": {
    name: "PDF to PowerPoint",
    description: "Convert the PDF into a PPTX deck with one page-image per slide (not editable text).",
  },
  "pdf-to-excel": {
    name: "PDF to Excel",
    description: "Pull the tables out of the PDF into an XLSX spreadsheet.",
  },
  "pdf-to-csv": {
    name: "Extract tables",
    description: "Pull only the tables out of a PDF into a CSV or JSON file.",
  },
  "pdf-to-pdfa": {
    name: "Check PDF/A",
    description:
      "Check whether your PDF meets PDF/A requirements and what's missing. Doesn't convert the file.",
  },
  "pdf-to-markdown": {
    name: "PDF to Markdown",
    description:
      "Extract the PDF text as Markdown: headings, lists, code and regular tables. With OCR for scanned pages.",
  },
  "pdf-to-text": {
    name: "PDF to Text",
    description:
      "Extract all the PDF text into a plain .txt file, page by page, no formatting. With OCR for scanned pages.",
  },
  "pdf-to-json": {
    name: "PDF to JSON",
    description:
      "Serialize the whole PDF as structured JSON: headings, paragraphs, lists, tables and code blocks. With OCR for scanned pages.",
  },
  "add-page-numbers": {
    name: "Add page numbers",
    description:
      "Add numbering choosing position, format, typeface and starting page.",
  },
  "add-watermark": {
    name: "Watermark",
    description:
      "Overlay text or an image with control over opacity, rotation and tiling.",
  },
  "crop-pdf": {
    name: "Crop PDF",
    description:
      "Adjust the document margins by drawing the useful area over the preview.",
  },
  "edit-pdf": {
    name: "Edit PDF",
    description: "Add text, images, shapes and highlights on top of the document pages.",
  },
  "sign-pdf": {
    name: "Sign PDF",
    description: "Draw, type or upload your signature and place it where you need it.",
  },
  "compare-pdf": {
    name: "Compare PDF",
    description:
      "Put two versions of the same document side by side and highlight text differences.",
  },
  "pdf-summarizer": {
    name: "Summarise PDF",
    description: "Get a summary of the document with its key points.",
  },
  "translate-pdf": {
    name: "Translation report",
    description:
      "Translate the PDF text with a local model into a page-by-page bilingual report. Doesn't return a translated PDF.",
  },
  "protect-pdf": {
    name: "Protect PDF",
    description:
      "Encrypt the document with a password so only the people you choose can open it.",
  },
  "unlock-pdf": {
    name: "Unlock PDF",
    description:
      "Remove what locks the document: its password or the certification of a digital signature.",
  },
  "redact-pdf": {
    name: "Redact PDF",
    description:
      "Cover sensitive data with opaque boxes and flatten the page so nothing can be recovered.",
  },
};

const filenames: Partial<Record<ToolSlug, string>> = {
  "merge-pdf": "merged-document",
  "split-pdf": "split-document",
  "remove-pages": "trimmed-document",
  "extract-pages": "extracted-pages",
  "organize-pdf": "organised-document",
  "rotate-pdf": "rotated-document",
  "jpg-to-pdf": "converted-document",
  "pdf-to-jpg": "page-images",
  "scan-to-pdf": "scanned-document",
  "add-watermark": "watermarked-document",
  "add-page-numbers": "numbered-document",
  "crop-pdf": "cropped-document",
  "sign-pdf": "signed-document",
  "compare-pdf": "compared-document",
  "compress-pdf": "compressed-document",
  "protect-pdf": "protected-document",
  "unlock-pdf": "unlocked-document",
  "redact-pdf": "redacted-document",
  "ocr-pdf": "document-ocr",
};

const categories: Record<
  ToolCategory,
  { label: string; description: string }
> = {
  organize: {
    label: "Organise",
    description: "Merge, split, reorder and clean up pages.",
  },
  optimize: {
    label: "Optimise",
    description: "Cut file weight and recover the text in your scans.",
  },
  "convert-to": {
    label: "Convert to PDF",
    description: "Bring images and documents into the PDF format.",
  },
  "convert-from": {
    label: "Convert from PDF",
    description: "Pull images, tables and other formats out of your PDF.",
  },
  edit: {
    label: "Edit and analyse",
    description: "Annotate, sign, number and compare documents.",
  },
  security: {
    label: "Security",
    description: "Encrypt, unlock and redact sensitive information.",
  },
};

export const en: Dictionary = {
  common: {
    brandFirst: "OPTIMUS",
    brandSecond: "PDF",
    live: "LIVE",
    soon: "COMING SOON",
    localBadge: "100% LOCAL",
    zeroUploads: "0 UPLOADS",
    localAndZeroUploads: "100% LOCAL · 0 UPLOADS",
    cancel: "Cancel",
    close: "Close",
    back: "Back",
    continueLabel: "Continue",
    loading: "Loading",
    language: "Language",
    spanish: "Spanish",
    english: "English",
    light: "Light",
    dark: "Dark",
    system: "System",
    skipToContent: "Skip to content",
    openMenu: "Open menu",
    closeMenu: "Close menu",
  },
  nav: {
    home: "Home",
    primaryNav: "Primary navigation",
    recent: "Recent",
    settings: "Settings",
    pricing: "Pricing",
    about: "Project",
    allTools: "See every tool",
    searchPlaceholder: "Search a tool…",
    searchEmpty: "No results",
    collapseSidebar: "Collapse sidebar",
    expandSidebar: "Expand sidebar",
    categoriesLabel: "Categories",
  },
  categories,
  home: {
    mostUsedTitle: "Most used",
    mostUsedSeeAll: "See history",
    liveCount: "available now",
    soonCount: "on the way",
  },
  tool: {
    dropTitle: "Drop your file here",
    dropTitleMultiple: "Drop your files here",
    dropSubtitle: "or tap to pick it from your device",
    dropButton: "Select file",
    dropButtonMultiple: "Select files",
    addMore: "Add more files",
    filesTitle: "Files",
    remove: "Remove",
    moveUp: "Move up",
    moveDown: "Move down",
    optionsTitle: "Options",
    openOptions: "Options",
    run: "Process",
    processingTitle: "Processing",
    processingHint: "Everything happens on your device. Do not close this tab.",
    doneTitle: "Done",
    doneSubtitle: "Your document is ready to download.",
    download: "Download",
    startOver: "Start over",
    resultSize: "Result size",
    relatedTitle: "Carry on with these",
    pagesPreview: "Page preview",
    dragToReorder: "Drag to reorder",
    selectAll: "Select all",
    clearSelection: "Clear selection",
    rotate: "Rotate",
    page: "Page",
    localNotice: "This file is not uploaded to any server.",
    errors: {
      title: "Could not finish",
      invalidType: "That format does not work with this tool.",
      encrypted:
        "This PDF is password protected. Remove the password first with Unlock PDF.",
      corrupt: "The file looks damaged and cannot be read.",
      empty: "You need to add at least one file.",
      needTwo: "This tool needs at least two files.",
      tooLarge:
        "The file is over 100 MB: your browser may run out of memory.",
      unknown: "Something went wrong during processing. Please try again.",
      cancelled: "Process cancelled.",
      wrongPassword: "That password does not open the document.",
      notProtected: "This document has no protection left to remove.",
      certificateEncryption:
        "This PDF uses digital certificate encryption: it is not supported by this tool.",
      unsupportedSecurityHandler:
        "This PDF uses an encryption method we do not recognise.",
      consentRequired:
        "This would invalidate the document's signatures: confirm it first.",
      inspectionIncomplete:
        "We could not safely check this PDF's restrictions, so we will not build a copy that might keep protections without telling you.",
      nothingSelected: "Select or mark something before processing.",
      ocrNetworkFailure:
        "Could not download the OCR engine's files. Check your connection and try again.",
      ocrEngineFailure:
        "The OCR engine failed while reading this document. Try again; if it keeps happening, the scanned pages may be unusable.",
      modelDownloadFailure:
        "Could not download the summarisation model. Check your connection and try again.",
      deviceLost:
        "The model could not finish. It is usually a lack of video memory: try the light model, close other tabs and try again.",
      legacyOfficeFormat:
        "We only support the modern format (.docx/.xlsx/.pptx), not the old one (.doc/.xls/.ppt). Save the file in the new format from Word, Excel, or PowerPoint and try again.",
      unsupportedScript:
        "This document has text (Chinese, Japanese, Korean, Arabic, Hebrew, Thai, or emoji, for example) that this tool cannot draw in the PDF yet. For now we only support Latin, Cyrillic, and Greek alphabets.",
      noTablesFound:
        "We could not find any table in this PDF. This tool only extracts tables with regular grids detected in the text layer: if the document is scanned pages (images), it will not recognise them.",
      invalidConfig:
        "This file is not a valid signing configuration (or its version isn't supported). Export it again from \"Sign PDF\" and try again.",
    },
  },
  soon: {
    badge: "COMING SOON",
    title: "Not ready yet",
    body: "This tool needs server-side conversion to produce a faithful result, and today OptimusPDF processes everything on your device. We would rather not pretend it works.",
    alternativesTitle: "In the meantime you can use",
    backHome: "Back to the catalogue",
  },
  recent: {
    title: "Recent",
    subtitle:
      "We only store the file name, the tool and the date, on this device. Never the document.",
    empty: "You have not processed anything in this browser yet.",
    emptyCta: "See tools",
    clear: "Clear history",
  },
  settings: {
    title: "Settings",
    themeTitle: "Appearance",
    themeBody:
      "Pick the light or dark theme. On “System” the app follows whatever your device is set to, and switches along with it.",
    languageTitle: "Language",
    languageBody: "Change the language of the whole interface.",
    dataTitle: "Local data",
    dataBody:
      "OptimusPDF keeps in your browser the chosen language, the list of recent jobs, and — if you used \"Sign PDF\" with several signers — the field values you typed (so they can be suggested in other documents) plus the drafts it saves automatically while you work (the full PDF and signature captures).",
    clearData: "Clear local data",
    cleared: "Local data cleared.",
    aboutTitle: "About the app",
    signPdfFeaturesTitle: "Sign PDF: new features",
    signPdfFeaturesBody:
      "Turn them on or off as you like. This preference is local to this browser only — it is never synced to an account or sent anywhere.",
    signPdfFeatures: {
      keyboardNav: {
        label: "Keyboard navigation",
        hint: "Tab or Enter jumps to the next empty text field without leaving the canvas.",
      },
      fieldsCompleteNotice: {
        label: "Pending fields notice",
        hint: "Shows a non-blocking notice if fields are still empty before you sign or download.",
      },
      undoDelete: {
        label: "Undo instead of confirming",
        hint: "Deleting a single text field shows an “Undo” button instead of asking for confirmation. Deleting a whole signer still asks for confirmation.",
      },
      reusableTemplates: {
        label: "Layout templates",
        hint: "Lets you save the signer/field layout as a template to reuse on other documents.",
      },
      richFieldTypes: {
        label: "Richer field types",
        hint: "Adds checkbox, date and initials as field types, alongside free text.",
      },
      completionCertificate: {
        label: "Completion certificate",
        hint: "Adds a final page with the document hash, the date and the list of signers.",
      },
      pinchZoom: {
        label: "Pinch to zoom",
        hint: "Lets you pinch-zoom the canvas on dense forms with many small fields.",
      },
    },
  },
  pricing: {
    title: "Pricing",
    subtitle:
      "Everything that runs in your browser is free and always will be. What needs servers does not exist yet.",
    freeName: "Local",
    freePrice: "€0",
    freePeriod: "forever",
    freeTagline: "Every tool that runs on your device.",
    freeFeatures: [
      "All working tools, with no usage limit",
      "No account, no email, no card",
      "No watermark and no quality downgrade",
      "No daily file limit",
      "Works offline after the first load",
    ],
    freeCta: "Use it now",
    proName: "Server",
    proPrice: "No price yet",
    proPeriod: "not available",
    proTagline:
      "For what a browser cannot do on its own: Office, PDF/A and language models.",
    proFeatures: [
      "Faithful Word, Excel and PowerPoint conversion",
      "Repair of damaged files",
      "Certified PDF/A export",
      "Summarising and translation with language models",
    ],
    proCta: "Not available yet",
    honestyTitle: "Why there is no comparison table",
    honestyBody:
      "Because there are not two plans competing. There is what already works, which is free, and what would need infrastructure, which we have not built. When it exists, the price will be stated right here.",
    faqTitle: "Quick questions",
    faq: [
      {
        q: "How can it be free?",
        a: "There are no servers to pay for. The cost of processing your PDF is paid by your own device.",
      },
      {
        q: "Is there a size limit?",
        a: "Whatever your browser memory can take. Above 100 MB we warn you before starting.",
      },
      {
        q: "Do you store my documents?",
        a: "We cannot: they never leave your machine. Only the name stays on this device if you use the recent history.",
      },
    ],
  },
  about: {
    title: "The project",
    subtitle: "A PDF suite built the other way round.",
    body: [
      "Almost every PDF tool on the internet works the same way: you upload your document, a server processes it and you trust that it gets deleted afterwards. OptimusPDF flips that deal. The engine travels to your browser and the file stays put.",
      "The result is a suite with no accounts, no queues, no daily limits and none of the discomfort of sending a payslip or a contract to somebody else's machine.",
      "Tools a browser cannot handle honestly are marked as coming soon. We do not invent half-finished results.",
    ],
    stackTitle: "How it is built",
    stackBody:
      "Next.js and TypeScript for the interface, pdf-lib to write documents, pdf.js to read and draw them, and background work so the tab never freezes.",
    valuesTitle: "Three rules",
    values: [
      {
        title: "Structural privacy",
        body: "Do not trust our policy: open the browser network panel and check that your file never travels.",
      },
      {
        title: "Product honesty",
        body: "If something cannot be done well locally, we say so. There are no decorative features.",
      },
      {
        title: "Real speed",
        body: "With no upload and no download, the total time is just the processing time.",
      },
    ],
  },
  footer: {
    tagline:
      "A PDF suite that runs entirely in your browser. Your documents do not travel.",
    product: "Product",
    toolsColumn: "Tools",
    company: "Company",
    legal: "Legal",
    privacy: "Privacy",
    terms: "Terms",
    cookies: "Cookies",
    licenses: "Licences",
    rights: "An Optimus Reframe project.",
  },
  tools,
  filenames,
};
