'use client';

import { useRouter } from '@/lib/hashRouter';
import Header from '@/components/Header';

/**
 * Step-by-step signup guide — reached at #/signup-guide. The public AI assistant
 * (Hamar Mall Assistant) links here when a user asks how to register, so the
 * screenshots captured by `scripts/signup-guide.mjs` are actually shown instead
 * of only described in text. Reachable only via the assistant — there is no nav
 * menu entry by design.
 *
 * Captions mirror the Business-account signup flow the screenshots walk through.
 */
type Step = { img: string; so: string; en: string };

const STEPS: Step[] = [
  { img: '01-signup-method.png',     so: 'Tag bogga signup-ka oo dooro "Email & Password".',
                                    en: 'Go to the signup page and choose “Email & Password”.' },
  { img: '02-account-type.png',      so: 'Dooro nooca akoonka. Tusaale ahaan, dooro "Business".',
                                    en: 'Pick an account type — for a shop, choose “Business”.' },
  { img: '03-business-selected.png', so: 'Markaad "Business" doorato, riix "Continue".',
                                    en: 'After selecting Business, press “Continue”.' },
  { img: '04-business-name.png',     so: 'Geli magaca ganacsigaaga.',
                                    en: 'Enter your business name.' },
  { img: '05-email.png',             so: 'Geli ciwaanka email-kaaga saxda ah.',
                                    en: 'Enter a valid email address.' },
  { img: '06-password.png',          so: 'Absooro password adag oo geli laba jeer si aad u xaqiijiso.',
                                    en: 'Create a strong password and type it twice to confirm.' },
  { img: '07-agree-terms.png',       so: 'Sax box-ka "I agree to the Terms".',
                                    en: 'Tick the “I agree to the Terms” box.' },
  { img: '08-create-account.png',    so: 'Riix "Create Account" si aad u dhameeyso.',
                                    en: 'Press “Create Account” to finish.' },
  { img: '09-success-billing.png',   so: 'Akoonka waa la abuuray! Waxaa la geeyay bogga billing-ka.',
                                    en: 'Your account is created! You’ll land on the billing page.' },
];

export default function SignupGuideView() {
  const router = useRouter();

  return (
    <div className="page-anim">
      <Header showSearch={false} />
      <div className="legal-wrap">
        <button className="auth-back-btn" onClick={() => router.back()}>← Back</button>

        <header style={{ textAlign: 'center', marginBottom: 18 }}>
          <h1 style={{ fontSize: '1.5rem', margin: '0 0 6px' }}>
            Hanuunka abuurista akoonka
          </h1>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            Step-by-step signup guide — follow the red arrow in each picture.
          </p>
        </header>

        {STEPS.map((s, i) => (
          <section key={s.img} className="legal-card" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: '1.05rem', marginBottom: 8 }}>
              {i + 1}. {s.en}
            </h2>
            <p style={{ color: 'var(--text-muted)', marginTop: 0, marginBottom: 12, fontSize: '.9rem' }}>
              {s.so}
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element -- static guide asset */}
            <img
              src={`/signup-guide/${s.img}`}
              alt={`Tallaabada ${i + 1}: ${s.en}`}
              loading="lazy"
              style={{
                width: '100%',
                maxWidth: 390,
                height: 'auto',
                display: 'block',
                margin: '0 auto',
                borderRadius: 12,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
              }}
            />
          </section>
        ))}

        <div style={{ textAlign: 'center', marginTop: 8, marginBottom: 32 }}>
          <button
            className="btn-primary"
            onClick={() => router.push('/auth/signup')}
            style={{ marginTop: 8 }}
          >
            Bilow hadda — Start now
          </button>
        </div>
      </div>
    </div>
  );
}
