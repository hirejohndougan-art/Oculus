# Deed of gift form builder and starter templates

John (2026-11-25): Oculus needs a **deed form builder**, a set of researched starter templates, and the choice to build a template from scratch or copy a starter one. This file is the brief for **T-069** (the builder) and the starter wording that ships with it. **T-067** (the online form a donor fills in and signs with a finger) uses templates made here.

> **Not legal advice.** The starter wording below was written for Oculus from common archival practice (sources at the end). Every organization should have its own attorney review the wording before using it, as T-067 already requires. The wording is meant to be edited, and the builder makes that easy.

## 1. What the builder does

### Templates

- A template belongs to one organization. Each site picks which of its organization's templates to offer (a site can offer several, for example a standard deed and an oral history release).
- **Starter templates** ship with Oculus (section 3). They can be used as they are, but can't be edited directly. **Copy** makes an editable copy, named "Copy of …".
- **New template** starts from a blank page, or from a minimal skeleton (donor details, description of the gift, signatures) that staff can delete.
- Templates have a **status**: draft, approved, retired. Only an **approved** template can be sent to donors or opened on a public site. Approving takes a system manager or someone with the Donor relations role, plus a recent sign-in (as role changes do, T-065), and goes in the change log.
- **Versions:** every save of an approved template makes a new version. A signed deed always keeps the exact version it was signed on, and its PDF is never regenerated from a newer version. Old versions stay readable, and retired templates stay attached to the deeds signed on them.
- **Translations:** a template can have the same form in more than one language (Spanish first, for Galveston County). Each language version is approved on its own, and the donor picks a language at the top of the form.

### Building blocks

Staff build a form from blocks, dragged into order, in sections that become steps on a phone.

| Block | What it is |
|---|---|
| Heading | A section title. |
| Text | Fixed wording, with **merge fields** such as `{{organization.name}}`, `{{donor.name}}`, `{{gift.date}}` (list below). Bold, italic, lists and links only. |
| Short answer, long answer | Text the donor types. Required or optional, with a length limit. |
| Name, email, phone, address | Typed fields with checking (email format, US and international phone, US address with ZIP, or free-form). |
| Date | A date picker, or "today" filled in automatically. |
| Single choice, multiple choice | Options the donor picks from. Each option can show or hide other blocks (see "Conditions"). |
| Agreement checkbox | A statement the donor must tick before signing, for example "I own these materials and have the right to give them." |
| Item list | Repeating rows for what is being given: description, how many, approximate date, condition, notes. Staff choose which columns appear. |
| Photo or file | The donor attaches photos of the items, or for digital gifts, a list of the files. Stored staff-only, with M-002's limits. |
| Initials | Short initials beside a clause (drawn or typed). |
| Signature | Drawn with a finger, stylus or mouse, or a typed name as the accessible choice (T-067). Each signature block says who signs it: donor, second donor, executor, organization's officer, interviewer, or the receiving organization's representative. |
| Staff-only section | Filled in by staff, never shown to the donor: accession number, received by, date received, notes. |
| Page break | Starts a new step on small screens. |

### Conditions

Any block can be shown only when an earlier answer matches. For example, "Closed until (date)" appears only if the donor picks "Closed to the public until a date", and the executor's details appear only if "I am giving these as executor of an estate" is chosen. Conditions are simple (this answer is / isn't one of these options) so they can be checked before a template is approved.

### Where answers go

Each block can be linked to a field on the accession, so a signed deed fills in the accession instead of being retyped:

- the donor's name and contact details → the donor's agent record (matched, never merged without staff confirming)
- the description and item list → the accession's materials
- the restriction choice → the accession's structured restriction (`closed_until` with its date, or `staff_and_researchers`, D-056)
- the copyright choice → the rights statement offered for the records made from the gift
- the disposal choice → a note on the accession
- the signed PDF → a deed file on the accession (T-066), with the deed status set to **signed** only after staff review it

Nothing is saved straight into published records. A signed form arrives as **waiting for staff review**.

### Checks before a template can be approved

- At least one donor signature block, and one receiving-organization signature block (it can be signed later by staff).
- Every merge field is one Oculus knows, and every condition points at an earlier block.
- Every required block can be reached.
- Accessibility (WCAG 2.1 AA): labels on every field, readable contrast, the typed-signature choice present, usable with a screen reader and a keyboard.
- The electronic-signature consent block (section 2) is present, unless the template is marked "paper only".

### Paper too

Any approved template can also be printed as a blank PDF, for donors who'd rather sign on paper. The signed paper copy is then scanned into the accession (T-066).

### Merge fields

`{{organization.name}}`, `{{organization.address}}`, `{{organization.email}}`, `{{organization.phone}}`, `{{site.name}}`, `{{donor.name}}`, `{{donor.address}}`, `{{donor.email}}`, `{{donor.phone}}`, `{{gift.date}}`, `{{gift.description}}`, `{{accession.number}}` (staff-only), `{{representative.name}}`, `{{representative.title}}`, `{{today}}`. Unknown merge fields are refused when saving.

## 2. Blocks every starter template shares

These are reused across the starter templates. In the builder they are a **shared clause library**: staff can insert any of them into their own templates.

**Electronic signature consent** (agreement checkbox, before signing)
> I agree to sign this form electronically. My electronic signature has the same effect as signing on paper. I can ask {{organization.name}} for a paper copy at any time.

**Ownership** (agreement checkbox)
> I own the materials described in this form, or I am authorized to give them, and to my knowledge no one else has a claim to them.

**Appraisal and taxes** (text)
> {{organization.name}} cannot appraise gifts or give tax advice. If you plan to claim a tax deduction, please talk to your tax advisor. The IRS generally asks donors to file Form 8283 when they claim more than $500 for donated property, and a qualified appraisal when the claim is over $5,000; check the IRS's current rules. We're happy to sign Form 8283 to confirm we received your gift.

**Restrictions** (single choice, with conditions)
- No restrictions: the materials may be made available to the public.
- Closed to the public until a date: *(shows a date field)*
- Available to staff and researchers only, not shown online.
- Other restriction, to be agreed with staff: *(shows a long answer)*

**Items we don't keep** (single choice)
> Sometimes a gift includes items that don't fit our collection, such as duplicates or items outside our area. If that happens, I'd like {{organization.name}} to:
- Return them to me (I'll keep my contact details up to date).
- Offer them to another historical society, library or museum.
- Dispose of them as it sees fit.

**Use, digitization and display** (text)
> {{organization.name}} may preserve, describe, copy, digitize and display the materials, in its buildings, in print and online, for research, education and exhibitions, subject to any restriction chosen above. It may decide how and when to display them and doesn't promise permanent display.

**If the organization closes** (text)
> If {{organization.name}} ever can't care for the materials, it will transfer them to another nonprofit historical society, archive, library or museum that will.

**Later additions** (text)
> Materials I give later may be added under the terms of this deed, if we both agree in writing.

**Binding on heirs** (text)
> This agreement binds me and my heirs, executors and successors.

**Acceptance** (signature block for the organization, staff-only until signed)
> Accepted for {{organization.name}} by {{representative.name}}, {{representative.title}}, on (date).

## 3. Starter templates

Each template lists its sections in order. "Shared:" means the block from section 2.

### 3.1 Standard deed of gift (gift and copyright)

For family papers, photographs, objects and documents where the donor gives everything, including any copyright they hold.

1. **About you:** name, address, email, phone.
2. **What you're giving:** item list (description, how many, approximate date, condition), "How did these come to you?" (long answer, optional), photos (optional).
3. **The gift:**
   > I, {{donor.name}}, give to {{organization.name}}, permanently and without conditions except those in this form, all my rights, title and interest in the materials described above.
4. **Copyright:**
   > I also transfer to {{organization.name}} any copyright I hold in these materials. I understand that I may not hold copyright in everything (for example, photographs taken by someone else, or published items), and that {{organization.name}} will respect the rights of others.
5. Shared: Restrictions, Items we don't keep, Use digitization and display, If the organization closes, Later additions, Binding on heirs.
6. Shared: Appraisal and taxes.
7. Shared: Ownership, Electronic signature consent.
8. **Signatures:** donor; second donor (optional, for joint owners); Shared: Acceptance.
9. **Staff only:** accession number, received by, date received, notes.

### 3.2 Deed of gift, donor keeps copyright

The same as 3.1, but the donor keeps copyright and gives the organization a license. Common for writers, artists, photographers and their families.

- Section 4 becomes a **single choice**:
  - I keep the copyright and give {{organization.name}} a permanent, non-exclusive, royalty-free license to copy, publish, display and share the materials, online and in print, for non-commercial research, education and exhibition. *(default)*
  - I keep the copyright and give the same license, and also allow anyone to reuse the materials under a Creative Commons Attribution-NonCommercial license (CC BY-NC 4.0).
  - I keep the copyright, and {{organization.name}} must ask me (or my heirs) before publishing copies. *(shows: "How to reach me or my heirs" long answer)*
- Adds: "When I die, my copyright passes to: (long answer, optional)."

### 3.3 Photographs, film and recordings

Based on 3.1, with questions archives need for visual and audio material.

- Item list columns: description, format (prints, negatives, slides, digital files, film, video, audio), how many, dates, who took or made them (if known).
- "Who are the people shown?" (long answer, optional).
- "Did you take or make these yourself?" (single choice: yes, all / some / no / don't know). If **yes, all or some**, the copyright section from 3.2 appears; otherwise the copyright paragraph from 3.1, noting that rights belong to whoever made them.
- An extra agreement checkbox: "Some of these may show people who are still living. I'd like {{organization.name}} to check with me before putting any of them online." (optional).

### 3.4 Oral history release (narrator)

For a person interviewed for an oral history. Matches common practice: each person interviewed signs their own release.

1. **About you:** name, address, email, phone.
2. **The interview:** project name, date or dates, interviewer's name, place (filled in by staff before sending, editable).
3. **Rights:** single choice:
   - I transfer the copyright in my interview (recording and transcript) to {{organization.name}}, which gives me back a non-exclusive license to use my own interview however I like. *(default)*
   - I keep the copyright and give {{organization.name}} a permanent, non-exclusive license to preserve, transcribe, publish and share my interview for research and education.
   - I dedicate my interview to the public domain (CC0), so anyone may use it.
4. **Your review:** agreement checkbox: "I've been offered the chance to review the transcript before it's shared." Optional: "I'd like to review the transcript before it's shared."
5. **Restrictions:** Shared: Restrictions, with an extra option: "The recording itself may not be published until after my death; the transcript may be."
6. **Understanding:** text:
   > Taking part is voluntary. I can stop the interview, skip any question, and ask for parts to be closed. My interview will be kept permanently by {{organization.name}} and may be shared with researchers and the public as I've chosen above.
7. Shared: Binding on heirs, Electronic signature consent.
8. **Signatures:** narrator; Shared: Acceptance.

### 3.5 Oral history release (interviewer)

For the person who conducted the interview (often a volunteer), so the organization holds both halves of the rights.

1. **About you:** name, email, phone.
2. **The interviews:** project name, list of interviews (narrator, date).
3. **Rights:** "I transfer to {{organization.name}} any copyright I hold in these interviews, their recordings, transcripts and my notes." (Or the license choice from 3.2, as a single choice.)
4. Agreement checkbox: "I explained the narrator's choices to them before the interview."
5. Shared: Electronic signature consent.
6. **Signatures:** interviewer; Shared: Acceptance.

### 3.6 Organization records

For a church, club, business, school or other group giving its records.

1. **About the organization:** its name, address, and the person signing: name, title, email, phone.
2. **Authority:** agreement checkbox: "I am authorized by the organization to give these records and sign this deed." Optional upload: board minute or letter authorizing the gift.
3. **What you're giving:** item list (description, date range, how many boxes or files), "Will the organization send more records later?" (yes/no). If yes, Shared: Later additions, worded as a standing agreement for future transfers.
4. **Gift and copyright:** as 3.1 (gift and copyright), with "the organization" in place of "I".
5. **Access:** Shared: Restrictions, plus: "Some records may hold private information about members or staff (for example, personnel or membership files). Please list any to be closed, and for how long." (long answer).
6. Shared: Items we don't keep, Use digitization and display, If the organization closes, Appraisal and taxes, Electronic signature consent.
7. **Signatures:** the organization's authorized officer; optional second officer; Shared: Acceptance.

### 3.7 Digital files and email

For born-digital gifts: files on a computer, drive, phone or cloud account, and email.

1. **About you:** name, address, email, phone.
2. **What you're giving:** where the files are (computer, drive, phone, cloud account, email account), roughly how many, date range, file types if known. Optional upload of a file list.
3. **How we'll receive them:** single choice: bring the device to us, we'll copy them with you, you'll send them by a shared link, or by mail on a drive.
4. **Gift and copyright:** as 3.1 or 3.2 (a single choice between the two).
5. **Privacy:** text and choices:
   > Digital files often include private information about you and others, such as passwords, financial or medical details, or messages from other people.
   - I'd like {{organization.name}} to remove anything it finds like that, without asking me. *(default)*
   - Please ask me before keeping anything like that.
   - Agreement checkbox: "I understand {{organization.name}} may make copies to preserve the files, and may check them for viruses."
6. **Copies and the original device:** single choice: return the device, wipe and return it, or keep it as part of the gift.
7. Shared: Restrictions, Use digitization and display, If the organization closes, Appraisal and taxes, Ownership, Electronic signature consent.
8. **Signatures:** donor; Shared: Acceptance.

### 3.8 Gift from an estate

For an executor, administrator or heir giving items on behalf of someone who has died.

1. **About you:** name, address, email, phone, and your role: executor or administrator / heir / other (long answer).
2. **About the person:** their name, date of death (optional), and their connection to the materials.
3. **Authority:** agreement checkbox: "I am authorized to give these materials on behalf of the estate." Optional upload: letters testamentary or other proof (stored staff-only).
4. **What you're giving:** item list.
5. **Gift and copyright:** as 3.1, on behalf of the estate, with the choice from 3.2 for copyright the estate holds.
6. Shared: Restrictions, Items we don't keep, Use digitization and display, If the organization closes, Appraisal and taxes, Electronic signature consent.
7. **Signatures:** executor or heir; optional second heir; Shared: Acceptance.

### 3.9 Temporary receipt (not a deed)

Used when items are left with the organization **before** it decides whether to accept them. It doesn't transfer ownership. When the gift is accepted, the donor signs one of the deeds above.

1. **About you:** name, address, email, phone.
2. **What you left with us:** item list, date left, photos (optional).
3. **Understanding:** text:
   > These items are in the care of {{organization.name}} while it decides whether to accept them. They still belong to you. If they are accepted, we'll ask you to sign a deed of gift. If they aren't, we'll contact you to collect them by (date). {{organization.name}} will take reasonable care of them but can't insure them.
4. Single choice, "If you don't collect them by that date": we'll contact you again / we may treat them as a gift (with a note that the organization will follow Texas law on unclaimed property; the attorney fills in the exact wording).
5. Shared: Electronic signature consent.
6. **Signatures:** owner; staff member receiving the items.

## 4. Building it

- **T-069** builds the builder, the shared clause library and the nine starter templates above as data (JSON, validated like other templates), with tests that every starter template passes the approval checks.
- **T-067** (the donor's online form) renders an approved template, collects signatures, makes the fixed PDF and files it on the accession (T-066). It depends on T-069.
- Starter wording ships as **draft**: an organization must copy and approve its own version (after its attorney's review) before any donor can see it.

## Sources

- Society of American Archivists, *A Guide to Deeds of Gift* (Christine Weideman, 2013): https://www2.archivists.org/publications/brochures/deeds-of-gift
- SAA Dictionary of Archives Terminology, "deed of gift": https://dictionary.archivists.org/entry/deed-of-gift.html
- Sustainable Heritage Network, *Steps for Creating a Deed of Gift*: https://sustainableheritagenetwork.mukurtu.org/system/files/atoms/file/Steps_for_Creating_a_Deed_of_Gift.pdf
- American Alliance of Museums, *In a Generous Spirit* (gift standards) and sample Deed of Gift: https://www.aam-us.org/?p=96204
- Arizona State Museum, Deed of Gift (Form 8283 note): https://statemuseum.arizona.edu/sites/default/files/repo-deed_of_gift_fillable-2022-07-28.pdf
- Duke University Libraries, oral history release templates: https://sites.duke.edu/archivox/2015/01/29/oral-history-basic-release-template/
- Montana State University Library, oral history release forms: https://guides.lib.montana.edu/oral_history/release_forms
- National Park Service, oral history legal and ethical issues: https://www.nps.gov/articles/000/oral-history-resources-considering-legal-and-ethical-issues.htm
- University of Houston, Oral History of Houston joint release form: https://www.uh.edu/class/ctr-public-history/oral-history/_docs/joint-release-form.pdf
- IRS Form 8283 instructions: https://www.irs.gov/pub/irs-pdf/i8283.pdf
