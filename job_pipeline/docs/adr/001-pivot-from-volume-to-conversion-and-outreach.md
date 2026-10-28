# ADR-001: Pivot from application-volume to conversion + outreach

- **Status:** Accepted (2026-10-28)
- **Decision Graph ref:** R49
- **Deciders:** User + PI
- **Supersedes:** the implicit "more applications = progress" operating model that shaped EA/iimjobs/Naukri/GCC/Gmail lanes since Oct 2

## Context

The pipeline was engineered to maximize **applications fired per unit time**. Every lane
(LinkedIn Easy Apply, iimjobs, Naukri, GCC, Gmail same-day alerts) optimizes discovery →
gating → submission throughput. The standing goal was "100 new relevant applications."

A conversion audit on 2026-10-28 revealed the uncomfortable gap between volume and results:

| Metric | Value |
|---|---|
| Total applications on record | 1,777 |
| ...with status `applied` only (fired-and-forgotten) | 1,663 (93%) |
| ...with an interview / offer / recruiter-response recorded | **0** |
| Outreach targets built | 90 |
| ...with recruiter / TA contacts mined | 60 |
| ...actually contacted | **0** |

**The system has no closed loop.** There is no stage after "apply": no response tracker,
no follow-up thread, no conversion analytics, no inbound capture. 60 recruiter/TA contacts
were mined and never used. This is a **volume treadmill**, not a job search.

## Why volume is the wrong optimizer for a senior profile

The profile is **11+ yrs, Director/Head/Founder's-Office/CoS/RevOps, 45 LPA expected,
India + UAE**. For senior roles the hiring channel is predominantly **inbound
(recruiter/TA outreach, referral, network)** — not mass cold Easy-Apply. A firehose of
hundreds of indistinguishable submissions:

- reads as undifferentiated → hurts positioning;
- converts at ~0% (matches the unmeasured reality);
- consumes 100+ hrs/wk on discovery+gating+applying that is better spent on one warm,
  targeted, personalized outreach per target.

## Decision

Restructure the pipeline around **conversion and warm outreach** as the primary metric,
not submission throughput:

1. **Add a closed loop.** A conversion/response tracker capturing, per application:
   recruiter response, interview booked, offer / rejection / no-reply / spam. Every apply
   is tracked to an outcome instead of fired-and-forgotten.
2. **Make outreach the new primary engine.** Begin personalized outreach to the **60
   already-mined recruiter/TA contacts** (highest-ROI untouched asset in the system),
   plus mine the remaining 30 targets that lack contacts.
3. **Follow-ups.** A nudge cadence (3 / 7 / 14 days) on no-reply applications.
4. **Dial DOWN blind EA volume.** Reduce unattended mass-EA runs; redirect that time to
   targeted outreach + response capture.
5. **Senior-relevant applies only.** Keep the strict 7.0 gate but bias it further toward
   genuinely senior, in-scope, not-yet-applied roles (FO/CoS/EIR fixes from R47 stay).

## Consequences

**Positive**
- Measures the metric that actually decides the outcome (conversion), making steering
  possible for the first time.
- Activates the untouched 60-contact outreach list — highest-ROI leverage available.
- Frees ~100 hrs/wk of volume busywork for warm, differentiated engagement.

**Negative / risks**
- Short-term application count will drop sharply (expected, intended).
- Requires new state: response/interview/offer fields + follow-up scheduler.
- Outreach quality varies; needs careful per-target personalization to avoid spam signals.
- Cannot solve phone-verified cold outreach limits without real user action (manual send).

## Alternatives considered

- **Keep volume, add the loop** — preserves the treadmill while adding capture; rejected
  because it still prioritizes counting applies over converting them.
- **Referral-first only, halt tooling** — too abrupt; referral network is thin today and
  tooling still produces legitimate senior targets (e.g. the 3 GREEN company-site roles).

## Metrics to watch going forward

- **Conversion rate**: applications → recruiter response → interview → offer.
- **Outreach response rate** on the 60-contact list.
- **Follow-up recovery**: how many no-replies become replies after 3/7/14-day nudges.
- Cap/halt any lane whose measured conversion is ~0 in favor of higher-converting activity.