# AuDrA scoring and the official stimuli

What CAP and MTCI actually are, where the official incomplete-shapes stimuli
come from, and how to score this project's exports with AuDrA.

Researched August 2026. Verify licence terms and availability before relying on
anything here for a publication.

## A correction to our own terminology

The project brief used "CAP/MTCI" as if CAP were a paper instrument. It is not.

| Name | What it actually is |
| --- | --- |
| **MTCI** | **Multi-Trial Creative Ideation** task (Barbot, 2018). The measure the incomplete-shapes task belongs to. Stimuli are abstract line fragments identified by letter, e.g. shapes **G, I, R**. Delivered through Barbot's **Crealyx** platform. |
| **CAP** | **Creativity Assessment Platform** (Patterson et al., 2025) — a free Penn State web app at `cap.ist.psu.edu` for building creativity assessments, collecting data, and scoring automatically. Its Drawing Task *is* the MTCI incomplete-shapes task. |
| **AuDrA** | **Automated Drawing Assessment** (Patterson, Barbot, Lloyd-Cox & Beaty, 2024). A ResNet-18 that scores MTCI drawings. Trained on 13,000+ drawing–rating pairs; r ≈ .65–.81 against human raters. |

So CAP is the delivery-and-scoring *platform*, MTCI is the *task*, and AuDrA is
the *scorer*. Our mode reimplements the MTCI incomplete-shapes task so the same
trial can be given to a human or an agent under matched conditions, and exports
images AuDrA can score.

## Getting the official stimuli

We do not ship them. The bundled `dev-fixture-02` is our own drawing and is not
an official MTCI stimulus. Three routes, best first:

1. **CAP** — `cap.ist.psu.edu`. Free, point-and-click, includes the Drawing Task
   with the official stimuli and built-in AuDrA scoring. Licensed **CC BY-NC-ND
   4.0**, so non-commercial and no derivatives: check whether re-serving a
   stimulus inside our own canvas is permitted before doing it.
2. **Contact the authors** — Baptiste Barbot (Crealyx / MTCI) for the stimulus
   set itself, John Patterson (Penn State) for AuDrA and CAP. For a
   methods-comparison study that needs the stimuli rendered in a custom canvas,
   this is the route most likely to produce a clean permission.
3. **The AuDrA drawing corpus** — <https://osf.io/h4adm/>. Participant drawings
   with the starting contours already drawn into them. Useful for calibration and
   for reading off what stimuli look like, but the contours are not separated
   from the responses, so it is not a stimulus source.

Once you have assets, follow "Adding the official starter-contour dataset" in
[audra-incomplete-shapes.md](audra-incomplete-shapes.md). Nothing downstream
knows contour geometry, so registering a stimulus is the only change needed.

## AuDrA: what it does to an image

From `AuDrA_run.py` and `AuDrA_DataModule.py` on <https://osf.io/kqn9v/>:

```python
in_shape  = [3, 224, 224]
img_means = 0.1612
img_stds  = 0.4075

transform = transforms.Compose([
    Invert(),                                # PIL.ImageOps.invert
    transforms.Resize(args.in_shape[-1]),    # 224
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.1612]*3, std=[0.4075]*3)
])
```

Consequences for anything feeding it images:

- **The image must be 3-channel RGB.** `PIL.ImageOps.invert` raises
  `OSError: not supported for this image mode` on RGBA. resvg renders RGBA, so
  this project encodes its own RGB PNGs (`src/audra/server/png.ts`) rather than
  leaving the flattening to whoever runs the scorer.
- **AuDrA inverts and resizes itself.** Supply normal dark-ink-on-white at any
  square size; do not pre-invert. `Resize(224)` with a single int scales the
  shorter edge, so a non-square image would not become 224×224 — ours is square.
- Predictions are min-max normalised (0–1) Judge Response Theory theta values
  (Myszkowski, 2019), not raw human rating units.

### Stroke width matters more than it looks

A 1024-unit artboard scaled to 224 shrinks strokes by 4.57×. Measured ink in the
scoring render:

| stroke width (artboard units) | px at 224 | darkest pixel | solid pixels (<100) |
| --- | --- | --- | --- |
| 3 | 0.66 | 100 | **0** |
| 5 | 1.09 | 17 | 440 |
| 6 | 1.31 | 17 | 512 |
| 8 | 1.75 | 17 | 834 |

At width 3 — the original default — **no pixel in the scoring image was ever
solid ink**; every mark antialiased to mid-grey. The pencil default is now **6**
and the minimum **4**, and the bundled fixture is drawn at width 6 to match, so
the contours and the participant's marks carry identical weight. Official
stimuli should be authored at the same weight.

## Scoring this project's exports

AuDrA is licensed **CC BY-NC-SA 4.0** (non-commercial, share-alike). Cite:

> Patterson, J. D., Barbot, B., Lloyd-Cox, J., & Beaty, R. E. (2024). AuDrA: An
> automated drawing assessment platform for evaluating creativity. *Behavior
> Research Methods*, 56, 3619–3636.

```bash
# 1. Download the AuDrA folder from https://osf.io/kqn9v/ (AuDrA_trained.ckpt is ~134 MB)

# 2. Environment
cd AuDrA
conda env create -f audra_environment_cpu.yml     # or audra_environment_gpu.yml
conda activate audra_cpu

# 3. Collect the scoring images from every exported trial
rm -f user_images/*
find /path/to/prj-simeval-pilot/exports -name final_canvas_score.png | while read f; do
  cp "$f" "user_images/$(basename "$(dirname "$f")").png"
done

# 4. Score
python AuDrA_run.py        # -> AuDrA_predictions.csv
```

`AuDrA_predictions.csv` has `filenames` and `predictions`. Because each file is
named after its bundle directory, join back to `session.json` on that name to
recover actor type, stimulus, timing, and the process measures — the scoring
image itself carries no identity, by design.

CPU is fine: the tutorial suggests 4 cores and 8 GB RAM, and under ~1000
drawings the GPU gains little.

### Verified compatibility

Checked against AuDrA's real preprocessing on an exported bundle:

- `final_canvas_score.png` — RGB, 224×224, non-interlaced, survives
  `ImageOps.invert`, and the full invert→resize→normalize pass yields a sane
  tensor range.
- `final_canvas_archival.png` — RGB, 2048×2048, for the record. Feeding either
  to AuDrA gives near-identical ink statistics, because 224 is rendered from the
  canonical SVG rather than downsampled from the archival raster.

`npm run test:audra-scoring-image` guards the RGB requirement.

## Licensing: what we may and may not do

Not legal advice. Confirm with the authors and your institution's research
office before collecting data.

| Component | Licence | Our use |
| --- | --- | --- |
| Barbot (2018), MTCI paper | CC BY 4.0 | Cite and quote freely. **Does not publish the stimulus set**, so it grants nothing over the stimuli themselves. |
| Patterson et al. (2025), CAP paper | CC BY 4.0 | Cite and quote freely. |
| `cap.ist.psu.edu` platform | CC BY-NC-ND 4.0 | Use the service. **ND** blocks distributing adaptations. |
| AuDrA code and weights | CC BY-NC-SA 4.0 | Download and run to score our images. |
| MTCI stimulus set | **No published licence found** | The blocker. See below. |

**Scoring with AuDrA and publishing the results is fine.** Running a model over
our own images is use, not adaptation: CC does not claim ownership of outputs,
so the scores and any analysis of them are ours to publish. Non-commercial
covers ordinary university research. ShareAlike only binds us if we distribute a
*modified* AuDrA — if we fine-tune it or patch its code and release that, the
release must be CC BY-NC-SA 4.0. Attribution is required either way.

**Re-serving the MTCI stimuli inside this app is the part that needs written
permission.** No licence grants it:

- The MTCI paper is CC BY but publishes only a sample item, so CC BY covers the
  article, not an unpublished stimulus bank.
- The stimuli reach researchers through CAP and Crealyx. CAP's site licence is
  ND, and lifting its stimuli into our own canvas is plausibly an adaptation.
- Crealyx publishes no terms we could locate.
- Beyond copyright, there is **test security**: reproducing or publishing
  stimulus images can compromise an instrument for future use, and authors
  often object on that ground alone.

Ask both authors directly — John Patterson (`jpttrsn@psu.edu`, corresponding
author on CAP/AuDrA) and Baptiste Barbot (MTCI/Crealyx) — for permission to
render the official contours inside a custom canvas for a human-versus-agent
methods comparison. Offering not to publish the stimulus images, only to
describe them, usually resolves the test-security objection.

### Why substituting our own stimuli is not a clean workaround

CAP deliberately refuses custom items:

> users can only select from the provided items and not edit or add custom
> items. This is important for ensuring that the AI scoring models will be able
> to accurately score participant responses.

AuDrA was trained on drawings made over the official contours. Novel stimuli put
it out of distribution, so the scores lose the validity evidence that motivated
using AuDrA in the first place. Custom stimuli avoid the permission question at
the cost of the measurement claim.

### Our task fidelity

CAP describes its Drawing Task as: a starting image of four contours that
loosely exhibit Gestalt closure; sketch a drawing as creative as possible
incorporating them; an eraser and an "Undo Last" button; a text box below the
canvas asking "What did you draw?". This mode implements exactly that, which is
good for comparability and also makes clear that it is a reimplementation of
their task — another reason to seek permission rather than infer it.

## Open questions to settle before data collection

- Which MTCI stimuli to use, and permission to render them in a custom canvas.
- Whether to score with AuDrA locally or through CAP, and whether the two agree
  on the same images.
- Whether AuDrA's training distribution — human pen drawings — is a fair scorer
  for agent polylines. It has not been validated on machine-generated drawings,
  and that is a limitation of the comparison, not of the pipeline.

## Sources

- AuDrA paper: <https://link.springer.com/article/10.3758/s13428-023-02258-3> · <https://pmc.ncbi.nlm.nih.gov/articles/PMC11133150/>
- AuDrA model, tutorial, scripts: <https://osf.io/kqn9v/> · drawings: <https://osf.io/h4adm/>
- CAP paper: <https://link.springer.com/article/10.3758/s13428-025-02761-9> · platform: <https://cap.ist.psu.edu>
- MTCI: Barbot (2018), <https://www.frontiersin.org/articles/10.3389/fpsyg.2018.02529/full>
- Pencils to Pixels (uses MTCI shapes G, I, R): <https://arxiv.org/abs/2502.05999>
