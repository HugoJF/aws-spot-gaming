export const range = (start: number, end: number): number[] => {
    return Array(end - start).fill(0).map((_, i) => i + start);
};
