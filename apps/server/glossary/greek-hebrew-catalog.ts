/**
 * Original Biblical Languages (Greek & Hebrew) Root Words & Strong's Concordance
 * definitions for live preaching intelligence.
 */

export type GreekHebrewEntry = {
  readonly root: string
  readonly language: "greek" | "hebrew"
  readonly strongsNumber: string
  readonly transliteration: string
  readonly definitionFr: string
  readonly definitionEn: string
  readonly triggers: readonly string[]
}

export const GREEK_HEBREW_CATALOG: readonly GreekHebrewEntry[] = [
  {
    root: "ἀγάπη",
    language: "greek",
    strongsNumber: "G26",
    transliteration: "Agape",
    definitionFr: "Amour divin inconditionnel, sacrificiel et désintéressé, motivé par le choix parfait de Dieu.",
    definitionEn: "Unconditional, sacrificial, self-giving divine love based on deliberate choice.",
    triggers: ["agape", "agapé", "amour agape", "agape love"],
  },
  {
    root: "שָׁלוֹם",
    language: "hebrew",
    strongsNumber: "H7965",
    transliteration: "Shalom",
    definitionFr: "Paix intégrale, plénitude, santé, prospérité et harmonie totale avec Dieu et la création.",
    definitionEn: "Wholeness, completeness, total peace, welfare, and harmonious communion with God.",
    triggers: ["shalom", "la paix shalom", "shalom de dieu"],
  },
  {
    root: "λόγος",
    language: "greek",
    strongsNumber: "G3056",
    transliteration: "Logos",
    definitionFr: "La Parole vivante, l'expression divine de Dieu incarnée en Jésus-Christ (Jean 1:1).",
    definitionEn: "The divine Word, supreme divine reason, and the expression of God incarnate in Christ (John 1:1).",
    triggers: ["logos", "le logos", "parole logos"],
  },
  {
    root: "רוּחַ",
    language: "hebrew",
    strongsNumber: "H7307",
    transliteration: "Ruach",
    definitionFr: "Souffle de vie, vent, Esprit de Dieu qui insuffle la vie et la puissance créatrice.",
    definitionEn: "Breath of life, wind, the Holy Spirit of God bringing life and creative power.",
    triggers: ["ruach", "ruah", "souffle ruach", "ruach hakodesh"],
  },
  {
    root: "חֶסֶד",
    language: "hebrew",
    strongsNumber: "H2617",
    transliteration: "Hesed",
    definitionFr: "Bonté fidèle de l'alliance, loyauté indéfectible et grâce inépuisable de Dieu.",
    definitionEn: "Covenant faithfulness, unfailing steadfast love, loyal kindness, and tender mercy.",
    triggers: ["hesed", "chesed", "la bonte hesed"],
  },
  {
    root: "κοινωνία",
    language: "greek",
    strongsNumber: "G2842",
    transliteration: "Koinonia",
    definitionFr: "Communion fraternelle intime, partage en profondeur et partenariat spirituel dans le Corps du Christ.",
    definitionEn: "Deep spiritual fellowship, mutual sharing, communion, and joint partnership in Christ.",
    triggers: ["koinonia", "la koinonia", "communion koinonia"],
  },
  {
    root: "δύναμις",
    language: "greek",
    strongsNumber: "G1411",
    transliteration: "Dunamis",
    definitionFr: "Puissance miraculeuse, force inhérente et capacité divine agissante par le Saint-Esprit (Actes 1:8).",
    definitionEn: "Miraculous dynamic power, inherent divine ability, and Holy Spirit strength (Acts 1:8).",
    triggers: ["dunamis", "puissance dunamis", "dunamis power"],
  },
  {
    root: "παράκλητος",
    language: "greek",
    strongsNumber: "G3875",
    transliteration: "Parakletos",
    definitionFr: "Le Consolateur, l'Avocat, celui appelé à nos côtés pour nous secourir : le Saint-Esprit (Jean 14:16).",
    definitionEn: "The Comforter, Helper, Advocate called alongside to support and counsel: the Holy Spirit.",
    triggers: ["paraclet", "parakletos", "le paraclet"],
  },
  {
    root: "μετάνοια",
    language: "greek",
    strongsNumber: "G3341",
    transliteration: "Metanoia",
    definitionFr: "Repentance véritable : transformation radicale de la pensée, du cœur et de la direction de vie.",
    definitionEn: "True repentance: a transformative change of mind, heart orientation, and direction towards God.",
    triggers: ["metanoia", "repentance metanoia"],
  },
  {
    root: "χάρις",
    language: "greek",
    strongsNumber: "G5485",
    transliteration: "Kharis",
    definitionFr: "Grâce, bienveillance divine imméritée qui accorde le salut, la faveur et la force spirituelle.",
    definitionEn: "Grace, unmerited divine goodwill extending salvation, blessing, and spiritual strength.",
    triggers: ["charis", "kharis", "la grace charis"],
  },
]
