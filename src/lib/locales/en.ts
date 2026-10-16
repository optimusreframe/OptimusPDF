import type { ToolCategory, ToolSlug } from "@/lib/tools-registry";
import type { Dictionary, ToolCopy } from "@/lib/locales/es";

const tools: Record<ToolSlug, ToolCopy> = {
  "pdf-pro": {
    name: "PDF Pro",
    description:
      "All in one: organize, edit, sign, protect and convert your PDF without leaving the page",
  },
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
    description:
      "Edit the text already in the PDF and add text, images and shapes directly on the document.",
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
  "pdf-pro": "pro-document",
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
    description: "Edit, sign, number and compare documents.",
  },
  security: {
    label: "Security",
    description: "Encrypt, unlock and redact sensitive information.",
  },
};

export const en: Dictionary = {
  common: {
    brandFirst: "Optimus",
    brandSecond: "PDF",
    live: "Available",
    soon: "Coming soon",
    localBadge: "100% local",
    zeroUploads: "0 uploads",
    localAndZeroUploads: "100% local · 0 uploads",
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
    documents: "My documents",
  },
  categories,
  home: {
    title: "Tools",
    searchPlaceholder: "Search tools",
    clearSearch: "Clear search",
    resultOne: "result",
    resultMany: "results",
    searchEmptyTitle: "Nothing matches your search",
    searchEmptyHint: "Try what you want to do: merge, compress, sign, convert…",
    mostUsedTitle: "Most used",
    mostUsedSeeAll: "See history",
    liveCount: "available now",
    soonCount: "on the way",
    featuredBadge: "New",
    featuredCta: "Open PDF Pro",
    featuredLabel: "Featured",
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
    accepts: "Accepts",
    upTo: "up to",
    dropActive: "Drop to add",
    skippedOne: "{names} was skipped: unsupported format.",
    skippedMany: "{count} files were skipped ({names}): unsupported format.",
    // Batch delivery with partial failures (`ProcessResult.report`).
    partialReportTitle: "{ok} of {total} documents signed",
    partialReportIntro: "Could not sign:",
    partialReportItem: "{name} ({reason})",
    // File problems (Wave 6 · U1/U3): banner with actions.
    fileProblemTitle: "This file cannot be used",
    fileProblemFile: "File: {name}",
    chooseAnother: "Choose another file",
    removeFile: "Remove file",
    enterPassword: "Enter the password",
    openRepair: "Open Repair PDF",
    openInPro: "Open in PDF Pro",
    continueInPro: "Continue in PDF Pro",
    needPageSelected: "Keep at least one page checked to be able to merge.",
    blockedRun: "{action} turns on when you change or remove the flagged file.",
    largeFileTitle: "Very large file",
    encryptedSheetMessage:
      "This PDF is password protected. Enter the password to work with an unprotected copy; the password is not stored.",
    restrictedNotice:
      "{name}: this PDF had editing or printing restrictions; you are working with a copy without them.",
    decryptedNotice:
      "{name}: you are working with a copy without a password. The password is not stored and the result will come out unencrypted.",
    password: {
      title: "PDF with a password",
      body: "Enter it to open the file. It is only used in your browser and is not stored. The result will have no password.",
      label: "Password",
      show: "Show the password",
      hide: "Hide the password",
      submit: "Open document",
      opening: "Opening…",
      cancel: "Cancel",
      wrong: "That password is not correct. Check it and try again.",
      failed: "The document could not be opened with that password. Try again.",
      close: "Close",
    },
    errorHints: {
      corrupt: "Try \"Repair PDF\" or choose another file.",
      tooLarge: "If it fails, try a smaller file.",
      tooLargeSplit: "If it fails, try a smaller file: you can split it first with \"Split PDF\".",
      unknown: "If it keeps happening, try another file.",
    },
    errors: {
      title: "Could not finish",
      emptyFile: "The file is empty (0 bytes). Choose another file.",
      notPdf:
        "This file is not a PDF, even though its name ends in .pdf (it may be an image or another format that was renamed). Choose a real PDF.",
      invalidType: "That format does not work with this tool.",
      encryptedAction: "Open Unlock PDF",
      reloadAction: "Reload the page",
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
      offline:
        "A component of the app couldn't be downloaded (you're offline, or the network failed). Your file is fine and never leaves your device: connect and reload the page (the automatic draft keeps your work).",
      nothingSelected: "Select or mark something before processing.",
      ocrNetworkFailure:
        "Could not load the OCR engine. Check your connection and try again.",
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
    badge: "Coming soon",
    title: "Not ready yet",
    body: "This tool needs server-side conversion to produce a faithful result, and today OptimusPDF processes everything on your device. We would rather not pretend it works.",
    alternativesTitle: "In the meantime you can use",
    backHome: "Back to the catalogue",
  },
  recent: {
    title: "Recent",
    subtitle:
      "Unfinished jobs are saved only in this browser, with the document, so you can continue them.",
    empty: "You have not processed anything in this browser yet.",
    emptyCta: "See tools",
    clear: "Clear history",
    unfinishedTitle: "Unfinished",
    unfinishedHint:
      "Jobs you left half-done. When you continue, the tool brings back the document and what you had done.",
    historyTitle: "History",
    historyHint:
      "For the history we only keep the file name, the tool and the date: you cannot continue from here.",
    openTool: "Open tool",
    documentsOne: "1 document",
    documentsMany: "{n} documents",
    changesOne: "1 change",
    changesMany: "{n} changes",
    discard: "Discard {name}",
    discardTitle: "Discard “{name}”?",
    discardBody:
      "The document and everything you had done with it will be deleted from this browser. This cannot be undone.",
    discardConfirm: "Discard",
    discarded: "Job discarded.",

    localOnly: "Only in this browser",
    localOnlyHint: "None of this is uploaded to any server.",
    statusUnfinished: "Unfinished",
    statusFinished: "Finished",
    reopen: "Open again",
    reopenHint: "Uses the copy saved in My documents.",
    removeRow: "Delete {name}",
    removed: "Entry deleted.",
    clearAll: "Delete everything",
    clearAllTitle: "Delete everything in Recent?",
    clearAllBody:
      "The history and every unfinished job, with its documents and what you had done, will be deleted from this browser. My documents is not touched. This cannot be undone.",
    clearAllConfirm: "Delete everything",
    clearAllDone: "Recent cleared.",
  },
  documents: {
    title: "My documents",
    subtitle: "Your contracts saved in this browser and the template for where each person signs.",
    privacy: "A copy is saved in this browser; use blank contracts, without client data.",
    loading: "Loading your documents…",
    add: "Add contract",
    seeAll: "See all",
    listLabel: "Saved documents",
    emptyTitle: "Upload your contracts once and set where each person signs",
    emptyBody: "After that, signing a contract takes one tap: signatures and initials appear by themselves where they belong.",
    pagesOne: "1 page",
    pagesMany: "{n} pages",
    statusReady: "Template ready (1 and 2 signers)",
    statusSingle: "1-signer template",
    statusNone: "No template",
    statusStale: "Template out of date",
    staleHint:
      "You replaced the PDF and it no longer matches the one the template was set up on: it won't be applied on its own. Set it up again or confirm it still applies.",
    reconfigure: "Set up again",
    reconfigureNamed: "Set up the template for {name} again",
    keepTemplate: "This template is still valid",
    keepTemplateNamed: "The template for {name} is still valid",
    announceKept: "The template for “{name}” was marked as valid.",
    sign: "Sign",
    signNamed: "Sign {name}",
    configure: "Set up template",
    configureNamed: "Set up template for {name}",
    moreActions: "More actions for {name}",
    moreActionsTitle: "{name}",
    select: "Select {name}",
    selectedOne: "1 selected",
    selectedCount: "{n} selected",
    signSelected: "Sign selected ({n})",
    selectionMax: "You can sign up to {max} documents at once.",
    clearSelection: "Clear selection",
    rename: "Rename",
    replace: "Replace PDF",
    delete: "Delete",
    renameTitle: "Rename document",
    nameLabel: "Name",
    save: "Save",
    deleteTitle: "Delete “{name}”?",
    deleteBody:
      "The copy of the PDF will be deleted from this browser. Its templates stay saved, without a document. This cannot be undone.",
    deleteConfirm: "Delete",
    addTitle: "Add contract",
    fileLabel: "PDF file",
    chooseFile: "Choose PDF",
    changeFile: "Choose another PDF",
    typeLabel: "Document type",
    typeHint: "For example: service contract",
    typeDefault: "Contract",
    saveDocument: "Save document",
    saving: "Saving…",
    storageTitle: "Storage",
    storageUsage: "{used} used of {max} · {n} of {maxDocs} documents",
    persistGranted: "Protected: the browser committed to not deleting these documents when space runs low.",
    persistDenied:
      "Not protected: the browser may delete this data if it needs space. Safari may delete it after 7 days without using the site.",
    persistUnsupported: "This browser does not offer persistent storage: it may delete this data if it needs space.",
    persistUnknown: "Protection against automatic deletion has not been requested yet.",
    persistRequest: "Request persistent storage",
    persistTip:
      "On iPad and iPhone: tap Share and choose “Add to Home Screen”, and back up your documents from time to time.",
    backup: "Back up my documents",
    backupSoon: "Coming soon",
    unavailableTitle: "This browser cannot save documents",
    unavailableBody:
      "My documents needs browser storage (IndexedDB) and it is not available here; you may be in a private window or have blocked it. Signing still works: you will just upload the PDF each time.",
    announceAdded: "“{name}” saved in My documents.",
    announceRenamed: "Document renamed to “{name}”.",
    announceDeleted: "“{name}” deleted.",
    announceReplaced: "The PDF of “{name}” was replaced.",
    replacedMismatch:
      "The PDF of “{name}” was replaced, but it no longer matches its template: it is now out of date and won't be applied on its own. Set it up again or confirm it still applies.",
    replacedReview:
      "The PDF of “{name}” was replaced. It changed on {n} pages: its template is now out of date and won't be applied on its own. Set it up again or confirm it still applies.",
    announcePersistGranted: "Persistent storage granted.",
    announcePersistDenied: "The browser did not grant persistent storage.",
    errorNotPdf: "Choose a PDF file.",
    errorTooBig: "That PDF is larger than 100 MB.",
    errorFull: "You reached the maximum of documents or space (50 documents, 400 MB).",
    errorQuota: "The browser has no free space to save this PDF.",
    errorUnavailable: "This browser does not allow saving documents.",
    errorEncrypted: "The PDF has an opening password: remove it before saving.",
    errorCorrupt: "The PDF could not be read: it is damaged or not a PDF.",
    errorConflict: "Another tab changed this document. The list was refreshed: try again.",
    errorNotFound: "That document no longer exists.",
    errorGeneric: "The action could not be completed. Try again.",
  },
  resume: {
    gone: "This work can no longer be recovered in this browser (it was deleted or expired).",
    reopen: "Open again",
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
      "OptimusPDF keeps in your browser the chosen language, the list of recent jobs, and — if you used \"Sign PDF\" with several signers — the field values you typed (so they can be suggested in other documents) plus the drafts it saves automatically while you work (with several documents, the whole session: documents, signers and fields, and the full PDF; the signatures already collected only if you leave \"Save collected signatures in the draft\" on, and they are deleted after 7 days). If you export a round's configuration, the .zip contains your documents. \"Clear local data\" removes all of this. If you tick \"Remember on this device\" when creating a signature or initials, they are also stored in your browser (IndexedDB) together with the name you type, so you can reuse them on other documents; they are never uploaded to any server. If you export a signature, the file contains the signature in the clear unless you protect it with a password. The PDF editor also saves an automatic draft (IndexedDB) with the whole document and your edits, so you can pick it up if you close the tab; it never leaves your device either and \"Clear local data\" removes it (no draft is kept for password-protected PDFs). PDF Pro does the same with its working document (the current PDF and the list of changes, in its own database) and \"Clear local data\" removes that too.",
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
        label: "Signature record (final page)",
        hint: "Adds a final \"Signature record\" page to the PDF with the date, the list of signers and the document hash. It is not a certified signature: it only records who signed and when. Off, the signed PDF has exactly the original pages.",
      },
      signingRecordFile: {
        label: "Include a separate .json record",
        hint: "When signing, offers a signing-record.json file with the SHA-256 hash of each signed PDF, the date, the signers and the page count. With several documents it goes inside the ZIP; with one, as a separate download. Never inside the PDF. It is not a certified signature.",
      },
      pinchZoom: {
        label: "Pinch to zoom",
        hint: "Lets you pinch-zoom the canvas on dense forms with many small fields.",
      },
      signatureVault: {
        label: "Saved signatures",
        hint: "Lets you remember your signatures and initials on this device to reuse them on other documents. It is optional: only what you tick is stored, and it never leaves the browser.",
      },
      signaturesInDraft: {
        label: "Save collected signatures in the draft",
        hint: "Also saves the strokes of the signatures and initials already collected, so they are not lost if you reload or leave. They are stored only on this device and deleted after 7 days. When off, the draft saves everything except the signatures: when you resume it they are asked for again. Drafts already saved keep their signatures until they expire or you remove them.",
      },
      multiDocument: {
        label: "Several documents at once",
        hint: "Lets you load several PDFs in Sign PDF and sign them in a single round. When off, the tool works with one document at a time, as before.",
      },
    },
    proFeaturesTitle: "PDF Pro: features",
    proFeaturesBody:
      "Preferences for the PDF Pro suite, kept only in this browser — they are never synced to an account or sent anywhere.",
    proFeatures: {
      proAutosave: {
        label: "Save an automatic draft",
        hint: "While you work, PDF Pro saves in your browser (IndexedDB) the current PDF and the list of changes, so you can pick it up if you reload or close the tab. Nothing is saved for password-protected PDFs. When off, an accidental close loses the unsaved work.",
      },
    },
    editPdfFeaturesTitle: "PDF editor: new features",
    editPdfFeaturesBody:
      "These options are local to this browser only — they are never synced to an account or sent anywhere.",
    editPdfFeatures: {
      editExistingText: {
        label: "Edit the text already in the PDF",
        hint: "Lets you click existing text and change it: on export, the original text is removed from the file and the new text is drawn; if it can't be removed, you're told. When off, the text already in the PDF can't be touched, but the editor still lets you add text, images and shapes.",
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
