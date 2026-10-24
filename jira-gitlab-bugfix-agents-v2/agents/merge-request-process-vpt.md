# Merge Request Process for VPT Repositories - Mandatory

## 1. Purpose

This document defines the **mandatory Merge Request (MR) process** for all VPT-owned repositories.

The goal is to:

- Reduce **delays in MR reviews**
- Prevent **production issues caused by missed regression scenarios and edge cases**
- Ensure **consistent quality across all contributions (internal and cross-team)**

This is a **strictly enforced process**. MRs not adhering to this will **not be reviewed or approved**.

---

## 2. VPT Services

- Verification Request
- Verification Workflow Engine
- Document Generation Service
- POI Service
- Verification Initiation Service
- Document Management Service
- Client Contract Service
- Core DS Service
- Payment Service
- Migration Service
- Alert Service
- Workflow Tools Service

---

## 3. Scope

This process applies to:

- All **VPT-owned repositories**
- All MRs raised by:
  - VPT team members
  - Any **external teams contributing to VPT services**

Applies to:

- Backend, Frontend, Mobile — **no exceptions**

---

## 4. Review Workflow

### Mandatory Review Flow

Peer Review → Service Owner Review → Approval

- Minimum **2 approvals required**
- **Peer review is mandatory**
- **Service Owner approval is mandatory**
- Service Owner **cannot approve without peer review**

---

## 5. MR Submission Requirement (Hard Gate)

An MR **will not be reviewed** unless all the following are met:

### 5.1 Submission Channel

- MR must be posted in **BE-Code Review Google Chat space**

---

### 5.2 Mandatory MR Checklist

Every MR must include:

- ✅ **Jira Ticket ID** in title
- ✅ **Local testing evidence**
- ✅ **Integration regression analysis summary**
- ✅ **Unit test coverage proof (no drop allowed)**
- ✅ **Cursor-generated regression analysis output (mandatory)**

> Regression analysis format → **TBD (standard prompt will be shared separately)**

---

### 5.3 Strict Rule

- If checklist is incomplete → **MR will not be reviewed**
- Reviewer can **reject MR immediately** for missing items

---

## 6. MR Size & Scope

- Each MR must be scoped to **one independent feature/change**
- Do **not combine multiple functionalities** in a single MR
- Prefer **small, focused MRs**

---

## 7. Review Timelines (Sprint Model)

### Sprint Cycle

- Sprint: **Wednesday → Tuesday**

### Merge Cutoff

- **No merges to** `develop` after Monday 4:00 PM

---

## 8. Reviewer SLA

- Review must be completed within **24 hours of MR submission**

---

## 9. Hotfix MR Process

- First step:
  - Raise MR to **master branch** and get approval
- After approval:
  - Deploy to **preprod branch** for QA handover and validation
- MR can be raised **only after QA approval (final validation stage)**
- Cannot be submitted on the **same day as fix version**
- Approval cutoff:
  - **4:00 PM (one day before fix version)**
- Reviewer SLA:
  - **6 hours**

---

## 10. Iteration Policy

- Maximum allowed review iterations: **3**

If exceeded:

- Reviewer must **close the MR**
- Author must **raise a new MR**

---

## 11. AI-Assisted Regression (Mandatory)

- Cursor-based regression analysis is **mandatory**
- Output must be:
  - Generated using standard prompt (to be shared)
  - Attached in MR description or comments

---

## 12. Enforcement

This process is enforced by:

- **Reviewers**
- **Service Owners**

They have full authority to:

- Reject MRs for **non-compliance**
- Skip review until **all requirements are met**

---

## 13. VPT Services & Service Owners

| #   | Service                         | Service Owners        |
| --- | ------------------------------- | --------------------- |
| 1   | Verification Request            | Lahari, Himanshu      |
| 2   | Verification Workflow Engine    | Lahari, Dipayan, Ravi |
| 5   | Document Generation Service     | Ravi                  |
| 6   | POI Service                     | Ravi                  |
| 7   | Verification Initiation Service | Dipayan               |
| 8   | Document Management Service     | Sachin                |
| 9   | Client Contract Service         | Himanshu              |
| 10  | Core DS Service                 | Himanshu              |
| 11  | Payment Service                 | Himanshu              |
| 12  | Migration Service               | Himanshu, Dipayan     |
| 13  | Alert Service                   | Sachin                |

---

## 14. Summary

- No peer review → **No approval**
- No service owner approval → **No merge**
- No regression clarity → **MR rejected**
- Large / mixed MRs → **Not accepted**
