# Personal Job Application Agent — Build Specification

> This document is the source of truth for implementing the project with Claude Code.
>
> The goal is **not** to build another generic autofill extension that guesses aggressively. The goal is to build a personal job-application agent that becomes extremely reliable for one applicant by maintaining a verified applicant profile, understanding arbitrary application fields, filling only when confidence is sufficient, and learning from corrections.

---

## 0. Instructions to Claude Code

You are implementing this project, not researching it.

Before writing code:

1. Inspect the repository and understand what already exists.
2. Preserve useful existing code and conventions.
3. If the repository is empty, scaffold the architecture described below.
4. Do **not** attempt to implement the entire long-term roadmap in one pass.
5. Build vertical slices that can be tested independently.
6. Prefer deterministic behavior over LLM calls whenever possible.
7. Never silently invent applicant information.
8. Never auto-submit a job application in the initial product.
9. Never mark an uncertain value as verified without explicit user action.
10. Never place API secrets in extension/client code.
11. Keep components small, typed, testable, and separated by responsibility.
12. Add tests as each core subsystem is implemented.
13. Keep a running `IMPLEMENTATION_STATUS.md` containing:
    - completed work,
    - current limitations,
    - known bugs,
    - next recommended task,
    - architectural decisions that deviate from this spec.

When a requirement is ambiguous, choose the option that minimizes the probability of an incorrect application answer.

### Primary engineering rule

> **Optimize for incorrect fills approaching zero, not fields-filled approaching 100%.**

A field left blank is recoverable. A confidently filled wrong answer is not.

---

# 1. Product Vision

Build a Chrome extension that turns job applications from a repetitive form-filling task into an exception-handling workflow.

The intended experience is:

```text
User creates/loads profile once
        ↓
User opens job application
        ↓
Extension understands visible application fields
        ↓
Known high-confidence answers are filled
        ↓
Uncertain / unknown questions are surfaced
        ↓
User corrects or answers them once
        ↓
Correction is remembered
        ↓
Future applications require less work
```

The product should eventually behave less like a traditional autofiller and more like a **personal application operator**:

- knows the applicant's canonical information,
- understands what a form is asking,
- fills factual information reliably,
- remembers repeated questions and corrections,
- understands ATS-specific UI quirks,
- later assists with application-specific written answers,
- leaves judgment calls to the user,
- provides a clear review before submission.

The human should increasingly become the exception handler rather than the person manually typing the same information over and over.

---

# 2. The Core Architectural Decision

Do **not** implement this architecture:

```text
resume.pdf
    ↓
AI reads resume
    ↓
AI guesses what every job field means
    ↓
AI fills page
```

Instead implement:

```text
Resume PDF/DOCX
       ↓
Document extraction
       ↓
Layout reconstruction
       ↓
Deterministic parsing + structured semantic fallback
       ↓
Canonical Applicant Profile
       ↓
One-time user verification
       ↓
Verified Profile Vault
       ↓
Application Field Detector
       ↓
Semantic Field Mapper
       ↓
Value Resolver
       ↓
Control / ATS Adapter
       ↓
Fill Engine
       ↓
Review
       ↓
Correction memory
```

### The resume is NOT the source of truth.

The resume is an onboarding input used to bootstrap the applicant profile.

Once the user verifies the extracted profile, the **ApplicantProfile** becomes the durable source of truth.

Do not repeatedly re-parse the resume every time an application asks for the user's school, employer, phone number, etc.

---

# 3. Product Scope

## 3.1 MVP / first usable product

The first genuinely useful version must support:

### Applicant onboarding

- upload PDF resume,
- extract text while preserving page/layout information,
- parse common resume information,
- generate a canonical applicant profile,
- show extracted information in a profile editor,
- visibly flag uncertain values,
- let the user correct every field,
- let the user mark the profile as verified,
- store the verified profile locally.

### Non-resume applicant data

The profile editor must also support user-entered fields commonly absent from resumes, including:

- legal/preferred name,
- address,
- work authorization,
- sponsorship now,
- sponsorship in the future,
- willingness to relocate,
- availability/start date,
- salary expectations,
- preferred locations,
- common links,
- optional demographic/EEO answers.

Never infer sensitive or legal application answers from unrelated resume information.

### Job application detection

On supported webpages:

- scan visible form controls,
- construct semantic descriptors for fields,
- infer the likely canonical profile field,
- calculate confidence,
- fill high-confidence matches,
- offer medium-confidence suggestions,
- leave low-confidence/unknown fields untouched,
- show what was filled and why.

### Basic control support

Support these generic controls first:

- `input[type=text]`
- `input[type=email]`
- `input[type=tel]`
- `input[type=url]`
- `input[type=number]`
- `textarea`
- native `select`
- checkbox
- radio buttons
- file upload for resume when a resume file has been explicitly selected/configured

### Learning

When the user corrects a mapping or answer:

- persist the correction,
- associate it with a semantic fingerprint,
- use it in future mappings,
- distinguish global, ATS, company, and exact-field mappings.

## 3.2 Explicitly NOT required for the first build

Do not block MVP completion on:

- Workday-specific automation,
- every custom JavaScript dropdown implementation,
- every ATS,
- automatic application submission,
- autonomous job discovery,
- mass application submission,
- cover letter generation,
- job-specific essay generation,
- scraping LinkedIn,
- cloud profile sync,
- OCR for every resume,
- perfect support for visual/two-column resumes,
- multi-user SaaS architecture,
- billing,
- analytics infrastructure,
- browser support outside Chromium.

Design interfaces so these can be added later, but do not prematurely build them.

---

# 4. Recommended Technology Stack

Use a browser-first TypeScript architecture.

## Extension

- TypeScript
- React
- Chrome Manifest V3
- WXT as the extension build/dev framework unless the existing repository already has a working equivalent MV3 setup
- Tailwind CSS for lightweight UI styling
- Zod for runtime schema validation

## Local persistence

- `chrome.storage.local` for:
  - profile metadata,
  - normalized applicant profile,
  - settings,
  - mapping rules,
  - lightweight verified answers.
- IndexedDB for:
  - original resume documents,
  - multiple resume versions,
  - application history,
  - learned mapping history,
  - larger answer memory later,
  - debug/audit records.

Create repository interfaces around storage. Application logic should not call raw browser storage everywhere.

## Resume processing

- Mozilla PDF.js for PDF extraction and page/layout coordinates.
- Mammoth.js later for DOCX support.
- OCR only as a fallback for image/scanned resumes.
- Tesseract.js/Scribe-style OCR can be added behind an adapter, but it is not necessary for the first milestone.

## Parsing

- deterministic regex/validators/heuristics first,
- Zod schemas for all structured data,
- semantic/LLM fallback behind an interface,
- do not make an LLM dependency mandatory for the first local MVP.

## Testing

- Vitest for unit tests,
- React Testing Library for extension UI,
- Playwright for end-to-end form fixtures and later real ATS regression testing.

## Backend

A backend is optional for the first local MVP.

When semantic LLM fallback is introduced, route requests through a backend rather than calling a model provider directly from the extension.

The extension must never contain an LLM API key.

---

# 5. Suggested Repository Structure

If starting fresh, use approximately:

```text
/
├── apps/
│   └── extension/
│       ├── entrypoints/
│       │   ├── background.ts
│       │   ├── content.ts
│       │   ├── sidepanel/
│       │   └── options/
│       ├── components/
│       ├── hooks/
│       └── assets/
│
├── packages/
│   ├── profile/
│   │   ├── schema.ts
│   │   ├── normalizers.ts
│   │   ├── repository.ts
│   │   └── selectors.ts
│   │
│   ├── resume-parser/
│   │   ├── pdf/
│   │   ├── layout/
│   │   ├── deterministic/
│   │   ├── semantic/
│   │   └── index.ts
│   │
│   ├── form-engine/
│   │   ├── detector/
│   │   ├── descriptor/
│   │   ├── mapper/
│   │   ├── resolver/
│   │   ├── confidence/
│   │   └── fingerprints/
│   │
│   ├── fill-engine/
│   │   ├── adapters/
│   │   ├── native/
│   │   └── verification/
│   │
│   ├── ats/
│   │   ├── generic/
│   │   ├── greenhouse/
│   │   ├── lever/
│   │   ├── workday/
│   │   └── detector.ts
│   │
│   ├── learning/
│   │   ├── mapping-memory.ts
│   │   ├── answer-memory.ts
│   │   └── outcomes.ts
│   │
│   ├── storage/
│   │   ├── chrome-storage.ts
│   │   ├── indexed-db.ts
│   │   └── migrations.ts
│   │
│   └── shared/
│       ├── messages.ts
│       ├── ids.ts
│       ├── logging.ts
│       └── errors.ts
│
├── fixtures/
│   ├── forms/
│   └── resumes/
│
├── tests/
├── prompt.md
├── README.md
└── IMPLEMENTATION_STATUS.md
```

If this structure would fight the existing repository, preserve the existing layout but maintain the same architectural boundaries.

---

# 6. Canonical Applicant Profile

This is the most important data model in the application.

## 6.1 Every value needs provenance

Do not store applicant values as naked primitives when provenance matters.

Use a structure like:

```ts
export type SourceType =
  | "resume"
  | "user"
  | "previous_application"
  | "derived";

export interface Evidence {
  source: SourceType;
  documentId?: string;
  page?: number;
  section?: string;
  originalText?: string;
  confidence: number;
  verifiedByUser: boolean;
}

export interface ProfileValue<T> {
  value: T | null;
  raw?: string;
  evidence: Evidence[];
}
```

Each important value should make it possible to answer:

- What is the value?
- What did the original source say?
- Where did this value come from?
- How confident is the system?
- Did the user verify it?
- Can it be normalized into different application formats?
- Has this semantic value successfully matched similar application fields before?

## 6.2 Initial profile schema

Implement a Zod schema and corresponding TypeScript types for at least:

```ts
interface ApplicantProfile {
  schemaVersion: number;

  identity: {
    legalFirstName: ProfileValue<string>;
    preferredFirstName: ProfileValue<string>;
    middleName: ProfileValue<string>;
    lastName: ProfileValue<string>;
    fullName: ProfileValue<string>;
  };

  contact: {
    email: ProfileValue<string>;
    phone: ProfileValue<NormalizedPhone>;
    addressLine1: ProfileValue<string>;
    addressLine2: ProfileValue<string>;
    city: ProfileValue<string>;
    state: ProfileValue<string>;
    postalCode: ProfileValue<string>;
    country: ProfileValue<string>;
  };

  links: {
    linkedin: ProfileValue<string>;
    github: ProfileValue<string>;
    portfolio: ProfileValue<string>;
    other: Array<ProfileValue<string>>;
  };

  education: Education[];
  employment: Employment[];
  projects: Project[];
  skills: ProfileValue<string[]>;

  applicationPreferences: {
    authorizedToWorkUS: ProfileValue<boolean>;
    requiresSponsorshipNow: ProfileValue<boolean>;
    requiresSponsorshipFuture: ProfileValue<boolean>;
    willingToRelocate: ProfileValue<boolean>;
    desiredSalary: ProfileValue<number>;
    availableStartDate: ProfileValue<NormalizedDate>;
    preferredLocations: ProfileValue<string[]>;
  };

  demographics: {
    gender: ProfileValue<string>;
    raceEthnicity: ProfileValue<string[]>;
    veteranStatus: ProfileValue<string>;
    disabilityStatus: ProfileValue<string>;
  };
}
```

Add useful fields as application fixtures reveal real needs, but avoid turning the schema into an unstructured dictionary.

## 6.3 Employment

```ts
interface Employment {
  id: string;
  company: ProfileValue<string>;
  title: ProfileValue<string>;
  location: ProfileValue<string>;
  startDate: ProfileValue<NormalizedDate>;
  endDate: ProfileValue<NormalizedDate>;
  currentlyEmployed: ProfileValue<boolean>;
  description: ProfileValue<string>;
  bullets: ProfileValue<string[]>;
}
```

## 6.4 Education

```ts
interface Education {
  id: string;
  institution: ProfileValue<string>;
  degree: ProfileValue<string>;
  fieldOfStudy: ProfileValue<string>;
  startDate: ProfileValue<NormalizedDate>;
  graduationDate: ProfileValue<NormalizedDate>;
  gpa: ProfileValue<string>;
}
```

## 6.5 Projects

```ts
interface Project {
  id: string;
  name: ProfileValue<string>;
  description: ProfileValue<string>;
  technologies: ProfileValue<string[]>;
  url: ProfileValue<string>;
}
```

---

# 7. Preserve Raw AND Normalized Values

Applications request the same fact in many formats.

Do not repeatedly ask AI to convert them.

## Dates

Store something like:

```ts
interface NormalizedDate {
  raw?: string;
  year?: number;
  month?: number;
  day?: number;
  iso?: string;
  isPresent?: boolean;
}
```

This should support rendering:

```text
May 2025
05/2025
2025-05
05/01/2025
May
2025
Present
```

## Phone

```ts
interface NormalizedPhone {
  raw: string;
  international?: string;
  national?: string;
  digits?: string;
  countryCode?: string;
}
```

## Entity aliases

Eventually support aliases such as:

```text
Rutgers University-New Brunswick
Rutgers University–New Brunswick
Rutgers New Brunswick
Rutgers, The State University of New Jersey
```

The canonical profile should know that semantically equivalent dropdown values may not be text-identical.

---

# 8. Resume Ingestion Pipeline

## 8.1 First supported resume domain

Start with:

- PDF,
- English,
- text-native PDFs,
- conventional/single-column or reasonably simple layout.

Do not claim universal parsing support.

## 8.2 Preserve layout

PDF.js output should be converted into a structure similar to:

```ts
interface ResumeTextItem {
  text: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
}

interface ResumeLine {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  items: ResumeTextItem[];
}

interface ResumeSection {
  type:
    | "header"
    | "summary"
    | "experience"
    | "education"
    | "projects"
    | "skills"
    | "certifications"
    | "unknown";
  heading?: string;
  lines: ResumeLine[];
}
```

Do not immediately flatten a PDF into one giant string.

Use signals such as:

- same Y coordinate,
- horizontal alignment,
- font size,
- whitespace gaps,
- common section headings,
- bullet patterns,
- date positioning.

## 8.3 Deterministic parsing first

Implement deterministic extractors for:

- email,
- phone,
- LinkedIn URL,
- GitHub URL,
- portfolio URLs,
- common date formats,
- common section headings,
- GPA patterns,
- obvious location/header patterns.

Then structure experience, education, project, and skills blocks using layout/section heuristics.

## 8.4 Semantic parser interface

Create an interface even if no remote semantic parser is initially wired:

```ts
interface SemanticResumeParser {
  parse(input: StructuredResumeInput): Promise<SemanticResumeResult>;
}
```

Requirements for semantic extraction:

- output must validate against a Zod schema,
- unsupported values must return `null`,
- every important value should include evidence,
- never infer citizenship,
- never infer work authorization,
- never infer sponsorship needs,
- never infer demographic information,
- never invent dates,
- never silently upgrade degree type or employment type.

## 8.5 Evidence validation

When semantic extraction is later enabled, verify that evidence quoted/referenced by the parser is actually present in the source representation whenever possible.

An extracted value unsupported by evidence should lose confidence or be rejected.

## 8.6 OCR fallback

Do not OCR text-native PDFs.

Future fallback:

```text
PDF
 ↓
usable text layer?
 ├─ yes → PDF text/layout parser
 └─ no  → render page images → OCR → parser
```

---

# 9. Profile Verification UX

After resume parsing, open a full-page onboarding/profile editor.

The interface should group fields by:

- Personal
- Contact
- Education
- Experience
- Projects
- Skills
- Links
- Application preferences
- Optional demographic answers

Each extracted field should show a state such as:

```text
✓ verified
● high confidence
? needs review
— missing
```

The user must be able to edit values before verification.

Once the user explicitly verifies a value:

```ts
confidence = 1;
verifiedByUser = true;
source = "user" or retain source + user verification evidence;
```

Do not re-parse and overwrite a verified value later without explicit user action.

---

# 10. Browser Extension Architecture

Use Manifest V3 responsibilities cleanly.

```text
JOB APPLICATION WEBPAGE
        ↕
CONTENT SCRIPT
DOM scanner + descriptor builder + fill executor
        ↕
SERVICE WORKER
coordination + profile resolver + storage access
        ↕
LOCAL DATA
chrome.storage.local + IndexedDB
        ↕
SIDE PANEL / OPTIONS UI
review + profile + correction controls
```

Future optional path:

```text
SERVICE WORKER
      ↓ narrow semantic request
BACKEND API
      ↓
LLM
```

## 10.1 Content script responsibilities

The content script may:

- inspect the page DOM,
- detect controls,
- build descriptors,
- generate local IDs/fingerprints,
- execute fill actions,
- verify whether the UI accepted a value,
- report newly inserted fields,
- send descriptors to the service worker.

The content script should **not**:

- load the entire applicant profile,
- contain API secrets,
- make arbitrary LLM calls,
- persist canonical profile data directly,
- autonomously submit the form.

## 10.2 Service worker responsibilities

The service worker should:

- validate incoming messages,
- load only required profile data,
- map fields to canonical paths,
- resolve values,
- return minimal fill instructions,
- store corrections/outcomes,
- coordinate ATS adapters.

Remember that MV3 service workers are ephemeral. Do not rely on global in-memory state for persistence.

---

# 11. Field Detection

Scan likely application controls:

```text
input
textarea
select
[role="textbox"]
[role="combobox"]
[role="checkbox"]
[role="radio"]
```

Ignore controls that are:

- hidden,
- disabled,
- clearly unrelated to the application form,
- search/navigation controls outside the application area where detectable.

Construct a descriptor rather than mapping from one attribute.

```ts
interface FieldDescriptor {
  localId: string;
  tag: string;
  type?: string;
  role?: string;

  label?: string;
  accessibleName?: string;

  name?: string;
  id?: string;
  placeholder?: string;
  autocomplete?: string;

  required: boolean;
  options?: string[];

  nearbyText?: string;
  sectionHeading?: string;

  pageUrl: string;
  hostname: string;
  ats: ATSKind;

  semanticFingerprint: string;
}
```

## 11.1 Semantic signals

Collect, when available:

1. HTML `autocomplete`
2. associated `<label>`
3. accessible name
4. `aria-label`
5. `aria-labelledby`
6. `name`
7. `id`
8. placeholder
9. control type
10. available options
11. nearby text
12. enclosing question container text
13. section heading
14. ATS identity

No single signal should be treated as universally trustworthy.

---

# 12. Semantic Field Mapper

The mapper answers:

> What canonical concept is this webpage asking for?

It should not directly manipulate the DOM.

## 12.1 Mapping cascade

Use this order:

```text
Field descriptor
      ↓
1. strong HTML semantics (`autocomplete`, etc.)
      ↓
2. exact/normalized alias registry
      ↓
3. ATS-specific rules
      ↓
4. previously learned user mapping
      ↓
5. fuzzy semantic matching
      ↓
6. narrow semantic/LLM fallback later
      ↓
7. unknown
```

## 12.2 Alias registry

Start with canonical aliases such as:

```ts
const aliases = {
  "identity.legalFirstName": [
    "first name",
    "legal first name",
    "given name",
    "forename",
    "candidate first name",
  ],
  "identity.lastName": [
    "last name",
    "surname",
    "family name",
    "legal last name",
  ],
  "contact.email": [
    "email",
    "email address",
    "e-mail",
    "personal email",
  ],
  "links.linkedin": [
    "linkedin",
    "linkedin profile",
    "linkedin url",
    "linkedin profile url",
  ],
};
```

Create normalized string utilities that:

- lowercase,
- trim,
- remove required asterisks,
- normalize punctuation,
- collapse whitespace,
- preserve meaningful negation words.

## 12.3 Result model

```ts
type KnowledgeState =
  | "known"
  | "derived"
  | "previously_seen"
  | "probable"
  | "unknown";

interface FieldMappingResult {
  fieldId: string;
  profilePath: string | null;
  confidence: number;
  knowledgeState: KnowledgeState;
  reasons: MappingReason[];
  source: "html" | "alias" | "ats" | "memory" | "fuzzy" | "semantic" | "none";
}
```

The system must explicitly distinguish:

```text
I KNOW this answer.
I can DERIVE this answer.
I have SEEN the user answer this before.
I THINK this is probably the answer.
I DON'T KNOW.
```

Never collapse those states into a single guess.

---

# 13. Confidence Policy

The exact thresholds will be calibrated with tests, but implement the architecture around three bands.

Recommended starting behavior:

```ts
if (confidence >= 0.95) {
  // safe to autofill factual field
} else if (confidence >= 0.75) {
  // suggest / require review
} else {
  // leave untouched
}
```

Example starting scores:

```text
0.99 exact semantic autocomplete match
0.98 exact ATS rule
0.97 exact normalized label alias
0.96 exact known name attribute
0.90+ strong multi-signal agreement
0.80s fuzzy/semantic interpretation
<0.75 ambiguous context
```

Do not hard-code these numbers across the entire codebase.

Create a centralized confidence policy/config module.

---

# 14. Value Resolver

The mapper identifies the semantic profile path.

The resolver answers:

> Given this semantic concept and this control, what exact value representation should be supplied?

Examples:

```text
contact.phone
    + input[type=tel]
    → (609) 555-1234

education[0].graduationDate
    + month dropdown
    → May

education[0].graduationDate
    + year dropdown
    → 2027

contact.country
    + options [United States, Canada]
    → United States
```

Create formatter/resolver functions rather than embedding formatting inside ATS adapters.

---

# 15. Fill Engine

The fill engine answers:

> How do I make this specific UI control actually accept the resolved value?

Use an adapter model.

```ts
interface ControlAdapter {
  name: string;
  canHandle(context: ControlContext): boolean;
  read(context: ControlContext): Promise<unknown> | unknown;
  fill(context: ControlContext, value: unknown): Promise<FillResult>;
  verify(context: ControlContext, expected: unknown): Promise<boolean>;
}
```

Initial adapters:

```text
NativeTextAdapter
NativeTextareaAdapter
NativeSelectAdapter
NativeCheckboxAdapter
NativeRadioAdapter
FileUploadAdapter
```

Later:

```text
ARIAComboboxAdapter
ReactSelectAdapter
GreenhouseControlAdapter
LeverControlAdapter
WorkdayControlAdapter
```

## 15.1 Controlled input handling

Do not rely on:

```ts
input.value = "value";
```

Use native property setters when required and dispatch appropriate bubbling events such as:

- `input`
- `change`
- potentially `blur` where a particular UI requires it

After a fill, verify that the UI reflects the expected value.

A fill is not considered successful merely because no exception was thrown.

---

# 16. Dynamic Forms

Applications can reveal new questions based on previous answers.

Use a debounced `MutationObserver` in the content script.

When meaningful new nodes appear:

1. rescan the affected region when possible,
2. create descriptors only for new/changed controls,
3. resolve them,
4. fill according to confidence policy.

Do not reprocess the entire page on every DOM mutation.

---

# 17. Iframes

Design scanning so frames can operate independently and report to the central extension coordinator.

Conceptually:

```text
                 service worker
               /       |       \
              /        |        \
        top frame   iframe 1   iframe 2
        scanner     scanner    scanner
```

Do not make iframe support block the first generic prototype, but avoid architectures that make adding it impossible.

---

# 18. ATS Architecture

Do not create five unrelated autofill systems.

Use:

```text
Generic semantic engine
        ↓
ATS detector
        ↓
optional ATS specialization
```

Interfaces:

```ts
type ATSKind =
  | "greenhouse"
  | "lever"
  | "workday"
  | "ashby"
  | "smartrecruiters"
  | "unknown";

interface ATSAdapter {
  ats: ATSKind;
  matchesPage(context: PageContext): boolean;
  enhanceDescriptor?(descriptor: FieldDescriptor): FieldDescriptor;
  mapField?(descriptor: FieldDescriptor): FieldMappingResult | null;
  getControlAdapter?(context: ControlContext): ControlAdapter | null;
}
```

Order of implementation:

1. Generic
2. Greenhouse
3. Lever
4. Workday
5. Ashby / others as recurring failures justify them

Workday should be treated primarily as a UI/control-manipulation specialization **after** the profile, descriptor, mapping, resolver, confidence, and fill abstractions are proven.

---

# 19. Learned Mapping Memory

This is one of the most important differentiators of the product.

Generic products must work reasonably for everyone.

This tool should become extremely good for the specific applicant using it.

Store corrections like:

```ts
interface LearnedMapping {
  id: string;
  scope: "global" | "ats" | "company" | "exact_field";
  ats?: ATSKind;
  hostname?: string;
  semanticFingerprint: string;
  normalizedLabel?: string;
  fieldType?: string;
  profilePath: string;
  userConfirmed: boolean;
  successfulUses: number;
  correctedUses: number;
  createdAt: string;
  updatedAt: string;
}
```

Examples:

```text
GLOBAL
"Given name" → identity.legalFirstName

ATS
Greenhouse + "Phone" → contact.phone

COMPANY
company.example + "Preferred hub" → applicationPreferences.preferredLocations

EXACT FIELD
specific semantic fingerprint → specific canonical answer
```

Confidence should increase when repeated mappings succeed without correction.

Confidence should decrease when the user repeatedly changes them.

---

# 20. Answer Memory vs Static Profile Data

Do not combine factual profile data with generated application prose.

They have different trust models.

## Static profile system

For questions with a factual answer:

```text
What is your GPA?
What is your phone number?
Are you authorized to work in the US?
What is your LinkedIn?
```

Use deterministic stored values.

## Answer knowledge base — later phase

For questions such as:

```text
Why do you want to work here?
Describe a technically challenging project.
Tell us about experience relevant to this role.
```

Create a separate subsystem later using:

- previous responses,
- resume bullets,
- project details,
- verified personal context,
- job/company context,
- user-edited final answers.

The first implementation should create interfaces/directories for this only if useful; do not build generated-answer behavior before factual autofill is reliable.

---

# 21. Privacy and Security Requirements

Treat applicant information as sensitive.

## 21.1 Data minimization

Bad:

```text
content script requests entire applicant profile
```

Good:

```text
content script sends descriptors for 3 fields
service worker resolves only those 3 values
content script receives only those 3 answers
```

Send the webpage context only the minimum applicant information necessary for currently detected fields.

## 21.2 Secrets

Never store an LLM/provider API key inside:

- content scripts,
- service worker code,
- popup/side panel code,
- bundled extension assets.

If AI is added:

```text
extension → authenticated backend → model provider
```

## 21.3 Sensitive values

Never infer:

- race/ethnicity,
- gender,
- disability,
- veteran status,
- citizenship,
- work authorization,
- visa status,
- sponsorship requirements

from names, schools, photos, location, language, or other indirect signals.

Only use explicit user-configured answers or explicit source evidence.

## 21.4 No auto-submit initially

The extension must not submit applications without a deliberate user action.

The initial product should stop at a reviewable filled form.

---

# 22. Extension UX

Use a side panel for in-application interaction.

## 22.1 Suggested states

### Page unsupported / no application detected

```text
No application form detected.
```

### Application detected

Show:

```text
Application detected
ATS: Greenhouse / Lever / Generic / Unknown

18 fields detected
13 ready to fill
3 need review
2 unknown

[Fill safe fields]
```

### After fill

Show a compact audit list:

```text
✓ First name     ← identity.legalFirstName
✓ Email          ← contact.email
✓ LinkedIn       ← links.linkedin
? Preferred hub  ← suggested preferredLocations
— Custom essay   ← unknown / unsupported
```

Each item should expose:

- detected question,
- predicted profile concept,
- confidence,
- selected answer,
- source/reason when useful,
- edit/correct action.

### Important

Avoid overwhelming the user with debugging metadata by default. Make detailed mapping/debug information available behind a developer/debug toggle.

---

# 23. Message Contracts

Define typed message schemas shared between extension contexts.

Example:

```ts
type ResolveApplicationFieldsRequest = {
  type: "RESOLVE_APPLICATION_FIELDS";
  page: {
    url: string;
    hostname: string;
    ats: ATSKind;
  };
  fields: FieldDescriptor[];
};

type ResolveApplicationFieldsResponse = {
  ok: true;
  actions: ResolvedFieldAction[];
};
```

Use Zod/runtime validation at trust boundaries.

Do not trust arbitrary message payloads from content scripts.

Create explicit versions if message schemas evolve materially.

---

# 24. Audit / Debug Model

Reliability requires visibility into why a fill occurred.

Create a lightweight local audit record:

```ts
interface FillAuditRecord {
  id: string;
  timestamp: string;
  pageUrl: string;
  ats: ATSKind;
  fieldFingerprint: string;
  detectedLabel?: string;
  mappedProfilePath?: string;
  mappingConfidence: number;
  mappingSource: string;
  fillAttempted: boolean;
  fillVerified: boolean;
  userCorrected: boolean;
}
```

Do not store unnecessary sensitive values in debug logs.

For development, provide a debug panel capable of showing:

- descriptor,
- mapping candidates,
- confidence reasons,
- selected adapter,
- verification result.

This will make ATS debugging dramatically easier.

---

# 25. Testing Strategy

Testing is core product work because the value proposition is reliability.

## 25.1 Unit tests

Create strong test coverage for:

- string normalization,
- alias matching,
- date parsing/formatting,
- phone normalization,
- profile path resolution,
- confidence calculation,
- semantic fingerprints,
- ATS detection,
- storage migrations,
- deterministic resume extraction.

## 25.2 Form fixtures

Create local HTML fixtures representing application patterns.

Examples:

```text
fixtures/forms/basic-contact.html
fixtures/forms/education.html
fixtures/forms/employment.html
fixtures/forms/radio-authorization.html
fixtures/forms/native-select.html
fixtures/forms/dynamic-dependent-question.html
fixtures/forms/ambiguous-fields.html
```

Each fixture should have expected detected descriptors and expected canonical mappings.

## 25.3 Regression cases

Any real application failure that gets fixed should become a fixture/test when feasible.

This is essential.

The learning loop for the codebase should be:

```text
real failure
   ↓
reproduce as fixture
   ↓
write failing test
   ↓
fix generic engine or adapter
   ↓
keep regression forever
```

## 25.4 Resume fixtures

Start with a small corpus of sanitized representative resumes.

Acceptance requirement:

> Every extracted value is either correct or visibly uncertain. Unsupported/fabricated values must not silently enter the verified profile.

---

# 26. Metrics for Development

Do not optimize first for raw fill rate.

Track at least:

```text
Field mapping precision
Verified-fill precision
Fill execution success rate
Incorrect-fill rate
User correction rate
Unknown-field rate
Repeated-question reuse rate
```

The most important metric is incorrect-fill rate.

A good system may initially fill fewer fields than competing autofillers while being much more trustworthy.

---

# 27. Implementation Phases

## Phase 0 — Repository foundation

Deliverables:

- extension loads unpacked in Chrome,
- TypeScript strict mode,
- React side panel/options page,
- shared packages/modules,
- Vitest configured,
- Playwright fixture test harness,
- typed extension messaging,
- local storage repositories,
- `IMPLEMENTATION_STATUS.md`.

Definition of done:

- extension builds,
- extension can open a side panel,
- content script can send a typed ping to the service worker,
- service worker can read/write a test value through repository abstraction,
- tests run with one command.

---

## Phase 1 — Canonical Applicant Profile

Deliverables:

- profile Zod schema,
- profile repository,
- profile migrations/versioning,
- profile editor UI,
- support for resume-derived and user-supplied values,
- provenance/confidence/verification metadata,
- raw + normalized date/phone values.

Definition of done:

- user can manually construct a complete applicant profile,
- profile survives browser restart,
- profile can be exported/imported as JSON for debugging/backup,
- verified values remain verified.

This phase can work before resume parsing exists.

---

## Phase 2 — Resume parsing onboarding

Deliverables:

- PDF upload,
- PDF.js extraction,
- text items with coordinates,
- line reconstruction,
- section detection,
- deterministic extraction,
- candidate values with confidence/evidence,
- onboarding review screen,
- merge into canonical profile without overwriting verified user values.

Initial supported fields:

- name,
- email,
- phone,
- location,
- LinkedIn,
- GitHub,
- portfolio,
- education,
- experience,
- projects,
- skills.

Definition of done:

- uploading a supported resume produces a reviewable structured profile,
- user can correct every extracted field,
- no unsupported field is invented,
- verification persists.

---

## Phase 3 — Generic semantic form engine

Deliverables:

- field scanner,
- accessible-label extraction,
- descriptor builder,
- semantic fingerprints,
- alias registry,
- mapping cascade,
- confidence model,
- value resolver,
- developer mapping playground.

Create an internal playground where developers can enter:

```text
Label: Given Name
Name: legal_first
Autocomplete: given-name
Type: text
```

and see:

```text
Predicted: identity.legalFirstName
Confidence: 0.99
Reasons: autocomplete + exact alias
Resolved value: ...
```

Definition of done:

- generic fixture fields map accurately without page-specific selectors,
- ambiguous fields are not treated as certain,
- mapping logic is testable without a browser page.

---

## Phase 4 — Generic fill engine

Deliverables:

- native control adapters,
- native property setter/event strategy,
- post-fill verification,
- side-panel audit UI,
- high/medium/low confidence behavior,
- MutationObserver rescans,
- user correction UI.

Definition of done:

- local generic fixtures can be filled end-to-end,
- controlled inputs update correctly,
- filled values are verified,
- uncertain fields remain reviewable,
- no form submission happens automatically.

At this point there should be a genuinely usable generic MVP.

---

## Phase 5 — Learned corrections

Deliverables:

- learned mapping schema/repository,
- global/ATS/company/exact scopes,
- correction capture,
- successful-use counters,
- correction counters,
- confidence adjustment based on history.

Definition of done:

- correcting a repeated field once materially improves the next mapping,
- learned rules can be inspected/deleted from settings,
- bad learned rules do not permanently trap the system.

---

## Phase 6 — Greenhouse + Lever

Deliverables:

- ATS detector,
- Greenhouse adapter for recurring descriptor/control quirks,
- Lever adapter for recurring descriptor/control quirks,
- regression fixtures from real applications,
- iframe handling where actually required.

Rule:

Only put behavior into an ATS adapter when the generic engine cannot reasonably handle it.

Do not duplicate the generic engine inside an adapter.

---

## Phase 7 — Workday

Only begin after Phases 1–6 are stable.

Focus Workday work on:

- custom comboboxes,
- dynamic sections,
- repeated structured experience/education entries,
- page transitions,
- control verification,
- ATS-specific fingerprints/selectors only where necessary.

The canonical mapping system should remain unchanged unless Workday reveals genuinely missing semantics.

---

## Phase 8 — Question / answer memory

After factual autofill is highly reliable:

- detect repeated custom questions,
- save user-approved answers,
- retrieve prior answers by semantic similarity,
- let user reuse/edit them,
- later generate job-specific drafts from approved personal context.

Do not automatically fabricate answers to open-ended application questions.

---

# 28. What NOT to Do

Do not:

- send every field to an LLM,
- send the entire applicant profile to every webpage,
- parse the resume on every application,
- infer missing legal/demographic answers,
- fill fields below confidence threshold just to raise fill rate,
- tightly couple profile schema to Greenhouse/Lever/Workday DOMs,
- put ATS-specific selectors in generic mapper modules,
- assume setting `.value` is enough,
- assume every dropdown is a `<select>`,
- rely on service-worker global variables for durable state,
- store model/API secrets in the extension,
- auto-submit applications in the initial product,
- build Workday before the generic engine,
- build generated application essays before factual profile autofill,
- build cloud infrastructure before the local personal tool is useful.

---

# 29. Coding Standards

- Enable TypeScript strict mode.
- No `any` unless accompanied by a comment explaining why it is unavoidable.
- Validate data entering storage and messages with Zod.
- Use dependency injection/interfaces for parser, storage, mapper, and adapters.
- Keep DOM-specific code out of pure mapping logic.
- Keep business logic out of React components.
- Prefer pure functions for descriptor normalization, mapping, confidence, and formatting.
- Add tests for every bug fix in core logic.
- Use stable semantic fingerprints rather than raw autogenerated DOM IDs when possible.
- Do not make network connectivity a requirement for basic factual autofill.
- Gracefully degrade: an unsupported field should remain untouched, not crash the entire scan.
- All extension errors should be caught and surfaced in developer logs without breaking the host page.

---

# 30. Initial Claude Code Task

Unless the repository already contains meaningful implementation, begin with **Phases 0 and 1**, then immediately build the field-mapping playground from Phase 3 before attempting real ATS sites.

The first coding sequence should be:

```text
1. Scaffold MV3 React/TypeScript extension
2. Configure strict typing + tests
3. Define ApplicantProfile + ProfileValue + Evidence schemas
4. Implement local repositories and migrations
5. Build profile editor
6. Add JSON import/export for development
7. Create shared FieldDescriptor types
8. Implement normalization + alias registry
9. Implement deterministic semantic mapper
10. Build mapping playground
11. Add generic HTML form fixtures
12. Implement content-script field detector
13. Connect descriptors → service worker → mapper
14. Implement native text/select/radio/checkbox adapters
15. Add fill verification
16. Add side-panel fill/review flow
17. Add correction memory
18. Only then add resume PDF ingestion
19. Only then test public Greenhouse/Lever applications
20. Workday later
```

### Important sequencing clarification

Resume parsing is important onboarding infrastructure, but do **not** let it block testing the core application engine.

A manually entered canonical profile is enough to develop and validate:

```text
field detection → semantic mapping → value resolution → fill execution → correction learning
```

This is the real core of the product.

---

# 31. First End-to-End Demo Target

The earliest convincing demo should be:

1. Load the extension.
2. Open the profile editor.
3. Enter or import a canonical applicant profile.
4. Open a local test job-application fixture.
5. Extension detects the application fields.
6. Side panel reports which fields it understands.
7. User clicks **Fill safe fields**.
8. First name, last name, email, phone, LinkedIn, education, and authorization questions fill correctly.
9. An intentionally ambiguous field is *not* blindly filled.
10. User assigns the ambiguous field once.
11. Reload another fixture containing the same semantic question with different HTML.
12. Extension remembers and maps it correctly.

If this works cleanly, the fundamental product architecture is validated.

---

# 32. Acceptance Criteria for the MVP

The MVP is successful when:

- a verified applicant profile exists independently of the resume,
- profile values retain provenance and verification state,
- generic application controls can be detected semantically,
- obvious fields map without AI,
- high-confidence factual fields fill reliably,
- filled values are programmatically verified,
- ambiguous fields remain reviewable rather than guessed,
- user corrections are persisted and reused,
- dynamic fields can be discovered after page updates,
- ATS-specific code is isolated behind adapters,
- the extension never auto-submits,
- no client-side secret exists,
- tests reproduce the core form-mapping/filling behavior.

---

# 33. Long-Term Product Direction

Once the core is trustworthy, evolve toward:

```text
Canonical applicant profile
        +
Resume variants
        +
Saved answer memory
        +
Job/application context
        +
ATS-specific execution
        ↓
Personal Job Application Agent
```

Eventually the system may:

- choose the best resume variant,
- reuse previous application answers,
- draft custom answers,
- understand job-specific context,
- identify unanswered required fields,
- navigate multi-step forms,
- maintain application history,
- help the user review every application quickly.

But every later capability must preserve the core trust model:

> **Known facts, derived facts, remembered answers, probabilistic guesses, and unknowns are different states. Treat them differently.**

The product wins by being trustworthy enough that the user can stop checking every obvious field while still knowing the system will stop and ask when it genuinely does not know.
