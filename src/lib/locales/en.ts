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
    description: "Convert the PDF into an editable PPTX deck.",
  },
  "pdf-to-excel": {
    name: "PDF to Excel",
    description: "Pull the tables out of the PDF into an XLSX spreadsheet.",
  },
  "pdf-to-pdfa": {
    name: "PDF to PDF/A",
    description: "Convert the document to the PDF/A standard for long-term archiving.",
  },
  "pdf-to-markdown": {
    name: "PDF to Markdown",
    description: "Convert the PDF content into structured Markdown.",
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
    description: "Add text, shapes and highlights on top of the document pages.",
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
    name: "Translate PDF",
    description: "Translate the document content into another language.",
  },
  "protect-pdf": {
    name: "Protect PDF",
    description:
      "Encrypt the document with a password so only the people you choose can open it.",
  },
  "unlock-pdf": {
    name: "Unlock PDF",
    description:
      "Remove the password from a PDF when you already know it and you are allowed to.",
  },
  "redact-pdf": {
    name: "Redact PDF",
    description:
      "Cover sensitive data with opaque boxes and flatten the page so nothing can be recovered.",
  },
};

const filenames: Partial<Record<ToolSlug, string>> = {
  "merge-pdf": "merged-document",
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
    skipToContent: "Skip to content",
    openMenu: "Open menu",
    closeMenu: "Close menu",
  },
  nav: {
    home: "Home",
    tools: "Tools",
    recent: "Recent",
    settings: "Settings",
    pricing: "Pricing",
    about: "Project",
    allTools: "See every tool",
  },
  categories,
  home: {
    badge: "LIVE · 100% LOCAL",
    title: "Every PDF tool.",
    titleAccent: "Zero uploads.",
    subtitle:
      "Merge, split, compress, convert, sign and protect documents without a single byte leaving your device. The engine runs entirely in your browser.",
    ctaPrimary: "Start working",
    ctaSecondary: "How it works",
    statTools: "Tools",
    statUploads: "Files uploaded",
    statAccounts: "Accounts needed",
    statAccountsValue: "None",
    toolsTitle: "The full catalogue",
    toolsSubtitle:
      "Tools grouped by what you actually need to do, not by what the industry sells.",
    privacyTitle: "Your files never leave your device",
    privacySubtitle:
      "This is not a marketing promise: it falls out of the architecture. There is no server to upload anything to.",
    privacyPoints: [
      {
        title: "Processed in the browser",
        body: "The PDF engine downloads once and works inside your tab's memory. The file stays where it is.",
      },
      {
        title: "No accounts, no tracking",
        body: "We ask for no email, set no tracking cookies and keep no document history.",
      },
      {
        title: "Works offline",
        body: "Once the app has loaded you can drop the wifi and carry on working exactly the same.",
      },
    ],
    ctaTitle: "Open a document and check for yourself",
    ctaBody: "No sign-up, no daily file limit, no hidden watermarks.",
    ctaButton: "Merge my first PDF",
  },
  toolsPage: {
    title: "Tools",
    subtitle:
      "The whole catalogue, grouped by task. The ones marked coming soon do not work yet, and we say so plainly.",
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
    languageTitle: "Language",
    languageBody: "Change the language of the whole interface.",
    dataTitle: "Local data",
    dataBody:
      "The only things OptimusPDF keeps in your browser are the chosen language and the list of recent jobs.",
    clearData: "Clear local data",
    cleared: "Local data cleared.",
    aboutTitle: "About the app",
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
