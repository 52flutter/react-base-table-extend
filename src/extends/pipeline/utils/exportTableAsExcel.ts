import type XLSX_NS from 'xlsx'
import { SpanRect } from '../features/autoRowSpan';
import { ArtColumn } from '../interfaces';
import SpanManager from './SpanManager';
import {
  collectNodes,
  flatten,
  getTreeDepth,
  isLeafNode,
  safeGetValue,
} from './utils';

function safeGetSpanRect(
  column: ArtColumn,
  record: any,
  rowIndex: number,
  colIndex: number,
): SpanRect {
  let colSpan = 1;
  let rowSpan = 1;
  if (column.getSpanRect) {
    const value = safeGetValue(column, record, rowIndex);
    const spanRect = column.getSpanRect(value, record, rowIndex);
    colSpan = spanRect == null ? 1 : spanRect.right - colIndex;
    rowSpan = spanRect == null ? 1 : spanRect.bottom - rowIndex;
  } else {
    if (column.colSpan != null) {
      colSpan = column.colSpan(record, rowIndex);
    }
    if (column.rowSpan != null) {
      rowSpan = column.rowSpan(record, rowIndex);
    }
  }

  // 注意这里没有考虑「rowSpan/colSpan 不能过大，避免 rowSpan/colSpan 影响因虚拟滚动而未渲染的单元格」

  return {
    top: rowIndex,
    bottom: rowIndex + rowSpan,
    left: colIndex,
    right: colIndex + colSpan,
  };
}

type XlsxCellDatum = string | number | null;

interface CellAddress {
  /** Column number (0-based) */
  c: number;
  /** Row number (0-based) */
  r: number;
}

function move({ c, r }: CellAddress, dx: number, dy: number): CellAddress {
  return { c: c + dx, r: r + dy };
}

function sanitizeCellDatum(value: any): XlsxCellDatum {
  if (
    value === Infinity ||
    value === -Infinity ||
    (typeof value === 'number' && isNaN(value))
  ) {
    return null;
  } else {
    return value;
  }
}

/** 根据 BaseTable 的 dataSource 和 column，将表格数据导出为 Excel 文件 */
export default function exportTableAsExcel(
  xlsxPackage: typeof XLSX_NS,
  _dataSource: any[],
  _columns: ArtColumn[],
  filename: string,
) {
  const dataSource = flatten(_dataSource);
  // 过滤掉隐藏的
  const columns = _columns.filter(p => p.hidden !== true);
  const sheet = xlsxPackage.utils.aoa_to_sheet([]);
  const topHeaderHeight = getTreeDepth(columns) + 1;

  const origin = { c: 0, r: 0 };
  addTopHeaders(origin);
  addDataPart(move(origin, 0, topHeaderHeight));

  if (filename.indexOf('.csv') > -1) {
    xlsxPackage.writeFile(
      {
        SheetNames: ['Sheet1'],
        Sheets: { Sheet1: sheet },
      },
      filename,
      { bookType: 'csv' },
    );
    return ;
  }

  xlsxPackage.writeFile(
    {
      SheetNames: ['Sheet1'],
      Sheets: { Sheet1: sheet },
    },
    filename,
  );

  function addTopHeaders(origin: CellAddress) {
    dfs(columns, 0, 0);

    function dfs(cols: ArtColumn[], startDx: number, startDy: number) {
      const start = move(origin, startDx, startDy);
      let offsetX = 0;

      for (const col of cols) {
        if (col.features?.noExport) {
          continue;
        }
        const current = move(start, offsetX, 0);
        addOne(col.title || '', current);

        if (isLeafNode(col)) {
          offsetX += 1;
          mergeCells(current, 1, topHeaderHeight - startDy);
        } else {
          const childrenWidth = dfs(
            col.children || [],
            startDx + offsetX,
            startDy + 1,
          );
          mergeCells(current, childrenWidth, 1);
          offsetX += childrenWidth;
        }
      }

      return offsetX;
    }
  }

  function addDataPart(origin: CellAddress) {
    const leafColumns = collectNodes(columns, 'leaf-only').filter(
      col => !col.features?.noExport,
    );
    const spanManager = new SpanManager();

    const dataPart = dataSource.map((record, rowIndex) => {
      spanManager.stripUpwards(rowIndex);

      return leafColumns.map((col, colIndex) => {
        if (spanManager.testSkip(rowIndex, colIndex)) {
          return null;
        }

        const spanRect = safeGetSpanRect(col, record, rowIndex, colIndex);
        const rowSpan = spanRect.bottom - spanRect.top;
        const colSpan = spanRect.right - spanRect.left;
        if (rowSpan > 1 || colSpan > 1) {
          spanManager.add(spanRect.top, spanRect.left, colSpan, rowSpan);
          mergeCells(
            move(origin, spanRect.left, spanRect.top),
            colSpan,
            rowSpan,
          );
        }

        return sanitizeCellDatum(
          col?.features?.exportValue
            ? col?.features?.exportValue(col, record, rowIndex)
            : safeGetValue(col, record, rowIndex),
        );
      });
    });
    add(dataPart, origin);
  }

  function add(data: XlsxCellDatum[][], origin: CellAddress) {
    xlsxPackage.utils.sheet_add_aoa(sheet, data, { origin });
  }

  function addOne(datum: XlsxCellDatum, origin: CellAddress) {
    xlsxPackage.utils.sheet_add_aoa(sheet, [[datum]], { origin });
  }

  function mergeCells(addr: CellAddress, width: number, height: number) {
    if (width === 1 && height === 1) {
      return;
    }
    if (sheet['!merges'] == null) {
      sheet['!merges'] = [];
    }
    sheet['!merges'].push({ s: addr, e: move(addr, width - 1, height - 1) });
  }
}
