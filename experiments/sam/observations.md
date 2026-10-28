# First live run: October 27, 2026

Ten cases completed against hosted `sam-3.1` using the six local fixture crops.
All inputs were rendered directly from the cleaned PDFs at 300 DPI,
1800 × 1800 pixels. The run used `@meta-sam/parser` 0.1.0, non-streaming Responses,
confidence enabled, and `one_bit` masks. One earlier toilet probe also completed.

The saved run is `.local/sam/2026-10-27T20-37-10-986Z-2f1dcc9d/`. Its report,
raw responses, and input hashes remain local with the drawings.

| Case                                   | Proposed objects | Elapsed case time |
| -------------------------------------- | ---------------: | ----------------: |
| Bathroom toilets, text                 |                2 |            2.64 s |
| Bathroom sinks, text                   |                0 |            1.68 s |
| Upper toilet, box                      |                1 |            1.17 s |
| Upper toilet, positive/negative points |                1 |            2.51 s |
| Absent yellow school bus, text         |                0 |            1.74 s |
| Kitchen sinks, text                    |                0 |            1.27 s |
| Revised air ducts, text                |                0 |            2.57 s |
| Baseline air ducts, text               |                0 |            2.31 s |
| Dense plumbing sinks, text             |                0 |            1.30 s |
| Electrical panel, text                 |                0 |            2.62 s |

Visual inspection of the three nonempty overlays found:

- The toilet concept covered the two visible toilet symbols, including their
  tanks. The reported confidences were approximately 0.844 and 0.855.
- The box prompt isolated the upper toilet, including its tank, at approximately
  0.941 confidence.
- The point prompt isolated the upper toilet bowl and omitted the tank, despite
  approximately 0.938 confidence. The boundary needed depends on the intended
  evidence, so confidence alone cannot choose between these outputs.

Toilet symbols are a useful candidate for the next experiment. These exact sink,
duct, and panel noun phrases did not find objects in these crops. That does not
establish that SAM cannot segment those classes with other prompts or locations.
The absent-concept result behaved as expected on this one input.

No ground-truth mask set, precision/recall, IoU, engineering-rule evaluation, or
controlled reasoning comparison has been completed. Human review remains pending
in the generated results. Meta reported one processed image per request and zero
text tokens in the inspected responses; that does not establish zero cost.

Next: label the intended toilet boundary, then compare reasoning on the same
crop with and without the proposed mask. Test a location prompt on a sink before
selecting an engineering rule. Keep panel clearance and automatic revision
conclusions outside this experiment.
