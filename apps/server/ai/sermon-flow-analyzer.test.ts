import { test } from "node:test"
import assert from "node:assert/strict"
import {
  classifySegmentPhase,
  classifySegmentTone,
  analyzeSermonFlow,
  type SermonSegment,
} from "./sermon-flow-analyzer"

test("classifySegmentPhase: correctly identifies introductory greetings and scripture openings", () => {
  assert.equal(classifySegmentPhase("Bonjour et bienvenue ce matin dans la maison de Dieu"), "introduction")
  assert.equal(classifySegmentPhase("Turn with me in your Bibles to John chapter 3"), "introduction")
})

test("classifySegmentPhase: identifies doctrinal exposition and Greek/Hebrew commentary", () => {
  assert.equal(classifySegmentPhase("Le texte dit ici en grec que le mot est agape"), "exposition")
  assert.equal(classifySegmentPhase("Dans le verset 16 l'apôtre Paul souligne le contexte"), "exposition")
})

test("classifySegmentPhase: identifies illustrations and analogies", () => {
  assert.equal(classifySegmentPhase("Laissez-moi vous raconter une histoire pour illustrer ceci"), "illustration")
  assert.equal(classifySegmentPhase("Imaginez un instant un berger marchant dans la vallée"), "illustration")
})

test("classifySegmentPhase: identifies practical application and altar call/prayer", () => {
  assert.equal(classifySegmentPhase("Comment appliquer cela dans votre vie cette semaine?"), "application")
  assert.equal(classifySegmentPhase("Courbons nos têtes et prions ensemble, amen"), "altar-call-prayer")
})

test("classifySegmentTone: classifies emotional and theological tones", () => {
  assert.equal(classifySegmentTone("Alléluia, gloire et louange à notre Seigneur!"), "praise_thanksgiving")
  assert.equal(classifySegmentTone("Tenez ferme et marchez par la foi dans la victoire"), "exhortation_faith")
  assert.equal(classifySegmentTone("Ne craignez rien car la paix de Dieu garde vos cœurs"), "comfort_peace")
  assert.equal(classifySegmentTone("Adoration et révérence devant la sainte majesté de Dieu"), "reverence_prayer")
  assert.equal(classifySegmentTone("Nous lisons la généalogie des rois"), "neutral_didactic")
})

test("analyzeSermonFlow: generates complete structural flow report and milestones", () => {
  const sampleSegments: SermonSegment[] = [
    { timestampMs: 0, text: "Bienvenue à tous ce matin, ouvrons nos Bibles." },
    { timestampMs: 60000, text: "Dans le verset 16, le texte dit que Dieu a tant aimé le monde." },
    { timestampMs: 120000, text: "Laissez-moi vous raconter une histoire qui illustre cela." },
    { timestampMs: 180000, text: "Comment appliquer cela dans votre vie pratique?" },
    { timestampMs: 240000, text: "Courbons nos têtes et prions le Seigneur, alléluia!" },
  ]

  const report = analyzeSermonFlow(sampleSegments)
  assert.equal(report.totalSegments, 5)
  assert.equal(report.phaseBreakdown.introduction, 1)
  assert.equal(report.phaseBreakdown.exposition, 1)
  assert.equal(report.phaseBreakdown.illustration, 1)
  assert.equal(report.phaseBreakdown.application, 1)
  assert.equal(report.phaseBreakdown["altar-call-prayer"], 1)
  assert.ok(report.keyMilestones.length >= 4)
})
