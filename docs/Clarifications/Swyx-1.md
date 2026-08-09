# Updates from Discord

## Questions from competitor

- for forms, is basic conditional logic enough or do you expect more complex rules?
- for category routing, should submissions automatically go to specific reviewers?
- for reviews, what's the minimum workflow you expect?
- after accepting an abstract, should speaker/session/tasks be created automatically?
- for speaker onboarding, what are the must-have tasks?
- do emails/calendar invites need to actually work, or can they be stubbed?
- for accelevents, should we mock the integration if we don't have api access?
- for the schedule, is day/room + drag-and-drop + conflict detection enough?
- for the agentic part, is a small useful agent enough since admin ui is the priority?

## Answers from organiser

1. conditional fine for now
2. yes talks are submitted to one or more tracks, and reviewes review one or more tracks
3. as above.. minimum workflow is just go from "unreviewed" -> "approve/maybe/deny" . bonus is being able to email speaker from inside the app to ask for changes/attach feedback when sending the approve/deny decision
4. yes
5. example shown in video is - 1) hotel stay requirement form, 2) flight reimbursement form. other optional task examples, 3) finalize talk description 4) finalize bio/photos, 5) announce participation, 6) invite colleagues with speaker discount
6. yes they should work on an MVP basis (it's easy to setup with cloudflare email or resend). obviously they can be done in depth. i will try to record a followup video today showing this further.
7. skip accelevents its fine, like i said its not required
8. yes  that is enough
9. yes correct admin ui is the priority