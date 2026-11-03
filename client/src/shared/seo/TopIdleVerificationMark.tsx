import { TOPIDLE_VERIFICATION_TOKEN } from './topidleVerification';

/** Token no DOM de todas as rotas React — crawler com JS e páginas internas. */
export function TopIdleVerificationMark() {
  return (
    <div hidden data-topidle-verification={TOPIDLE_VERIFICATION_TOKEN}>
      {TOPIDLE_VERIFICATION_TOKEN}
    </div>
  );
}
