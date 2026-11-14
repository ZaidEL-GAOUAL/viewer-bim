/**
 * Fait avancer un travail découpé en tranches (un générateur qui rend son avancement, de 0 à 1, à chaque pause) par
 * périodes de `sliceMs` entre deux images, comme la coupe (CutDisplay) : le fil principal n'est jamais bloqué longtemps.
 * `signal` l'interrompt : la promesse est alors rejetée (`AbortError`).
 */
export function runSliced<T>(job: Generator<number, T, unknown>, onProgress: (progress: number) => void = () => {}, signal?: AbortSignal, sliceMs = 12): Promise<T> {
  return new Promise((resolve, reject) => {
    const step = () => {
      if (signal?.aborted) {
        job.return(undefined as T);
        reject(new DOMException('Calcul interrompu.', 'AbortError'));
        return;
      }
      try {
        const until = performance.now() + sliceMs;
        let next = job.next();
        while (!next.done && performance.now() < until) next = job.next();
        if (next.done) resolve(next.value);
        else {
          onProgress(next.value);
          setTimeout(step, 0);
        }
      } catch (error) {
        reject(error);
      }
    };
    step();
  });
}
